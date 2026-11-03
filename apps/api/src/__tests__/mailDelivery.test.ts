import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { compose, deliverSmtp, classifySmtpError, MailError, createCampaign, submitCampaign, runCampaign } from '@tupo/mail';

/**
 * C-06: SMTP delivery is safe to run concurrently, classifies failures
 * correctly, and per-sender recipient caps hold.
 */

/** A scripted relay: unknown@ → 550 5.1.1, relay@ → 554 5.7.1, anyone else accepted. */
function relay() {
  const accepted: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let buf = ''; let inData = false; let rcpt: string[] = [];
    sock.write('220 relay.test ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf(inData ? '\r\n.\r\n' : '\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + (inData ? 5 : 2));
        if (inData) { inData = false; accepted.push(...rcpt); rcpt = []; sock.write('250 OK queued\r\n'); continue; }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250-relay.test\r\n250 OK\r\n');
        else if (up.startsWith('RCPT TO')) {
          const addr = line.slice(line.indexOf('<') + 1, line.indexOf('>'));
          if (addr.startsWith('unknown')) sock.write('550 5.1.1 User unknown\r\n');
          else if (addr.startsWith('relay')) sock.write('554 5.7.1 Relay access denied\r\n');
          else { rcpt.push(addr); sock.write('250 OK\r\n'); }
        } else if (up.startsWith('DATA')) { inData = true; sock.write('354 go\r\n'); }
        else if (up.startsWith('QUIT')) { sock.write('221 Bye\r\n'); sock.end(); }
        else if (up.startsWith('RSET')) { rcpt = []; sock.write('250 OK\r\n'); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  return new Promise<{ port: number; accepted: string[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: (server.address() as net.AddressInfo).port, accepted,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    }));
  });
}

let sender: string;
let internal: string;
let sink: Awaited<ReturnType<typeof relay>>;
let env: NodeJS.ProcessEnv;
const tag = snowflake();
const ext = (local: string) => `${local}-${tag}@outside.example`;

async function user(name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>(`SELECT id FROM roles WHERE name = 'Staff'`);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`,
    [id, name, `${id}@amashuri.com`, rows[0]!.id]);
  return id;
}
async function rows(messageId: string) {
  return (await getPool().query<{ address: string; delivery_status: string; attempts: number; next_attempt_at: Date | null }>(
    `SELECT address, delivery_status, attempts, next_attempt_at FROM mail_recipients WHERE message_id = $1 AND channel = 'smtp' ORDER BY address`,
    [messageId])).rows;
}
const suppressed = async (address: string) =>
  (await getPool().query('SELECT 1 FROM mail_suppressions WHERE address = $1', [address.toLowerCase()])).rows.length > 0;

beforeAll(async () => {
  await seedRbac(getPool());
  sender = await user('Sender');
  internal = await user('Colleague');
  sink = await relay();
  env = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.port), SMTP_SECURE: 'false', MAIL_FROM: 'tupo@amashuri.com', MAIL_SMTP_RATE_PER_MIN: '1000' };
});
afterAll(async () => {
  const pool = getPool();
  await pool.query(`DELETE FROM mail_suppressions WHERE address LIKE $1`, [`%-${tag}@outside.example`]);
  await pool.query('DELETE FROM mail_delivery_events WHERE message_id IN (SELECT id FROM mail_messages WHERE from_user_id = $1)', [sender]).catch(() => {});
  await pool.query('DELETE FROM mail_recipients WHERE message_id IN (SELECT id FROM mail_messages WHERE from_user_id = $1)', [sender]);
  await pool.query('DELETE FROM mail_messages WHERE campaign_id IN (SELECT id FROM mail_campaigns WHERE created_by = $1)', [sender]);
  await pool.query('DELETE FROM mail_campaigns WHERE created_by = $1', [sender]);
  await pool.query('DELETE FROM mail_messages WHERE from_user_id = $1', [sender]);
  await pool.query('DELETE FROM mail_threads WHERE created_by = $1', [sender]).catch(() => {});
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [[sender, internal]]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[sender, internal]]);
  await sink.close();
  await closeDb();
});

describe('classifying relay errors', () => {
  it('only an address-level rejection is a bounce', () => {
    expect(classifySmtpError({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, response: '550 5.1.1 User unknown' })).toBe('recipient');
    expect(classifySmtpError({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 554, response: '554 5.7.1 Relay access denied' })).toBe('transport');
    expect(classifySmtpError({ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535, response: '535 5.7.8 Bad credentials' })).toBe('transport');
    expect(classifySmtpError({ code: 'ECONNECTION' })).toBe('transport');
    expect(classifySmtpError({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 450, response: '450 4.2.0 Mailbox busy' })).toBe('transport');
    expect(classifySmtpError({ code: 'EMESSAGE', command: 'DATA', responseCode: 552, response: '552 5.3.4 Message too big' })).toBe('message');
  });
});

describe('delivery', () => {
  it('three overlapping runs send each copy exactly once', async () => {
    const to = [ext('a'), ext('b'), ext('c')];
    const { messageId } = await compose(sender, { to, subject: 'once', bodyHtml: '<p>x</p>' });
    await Promise.all([deliverSmtp(messageId, env), deliverSmtp(messageId, env), deliverSmtp(messageId, env)]);
    for (const a of to) expect(sink.accepted.filter((x) => x === a)).toHaveLength(1);
    expect((await rows(messageId)).every((r) => r.delivery_status === 'delivered')).toBe(true);
  });

  it('an unknown outside address bounces and is suppressed', async () => {
    const bad = ext('unknown');
    const { messageId } = await compose(sender, { to: [bad], subject: 'bounce', bodyHtml: '<p>x</p>' });
    await deliverSmtp(messageId, env);
    expect((await rows(messageId))[0]!.delivery_status).toBe('bounced');
    expect(await suppressed(bad)).toBe(true);
  });

  it('a relay refusal retries later, suppresses nobody, and leaves the rest untouched', async () => {
    const denied = ext('relay'); const fine = ext('zz-fine');
    const { messageId } = await compose(sender, { to: [denied, fine], subject: 'relay down', bodyHtml: '<p>x</p>' });
    await deliverSmtp(messageId, env);
    const [r1, r2] = await rows(messageId);   // ordered: relay-…, zz-fine-…
    expect(r1!.delivery_status).toBe('queued');
    expect(r1!.attempts).toBe(1);
    expect(r1!.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await suppressed(denied)).toBe(false);
    expect(r2!.delivery_status).toBe('queued');
    expect(r2!.attempts).toBe(0);
    // Not due yet, so an immediate re-run sends nothing.
    await deliverSmtp(messageId, env);
    expect(sink.accepted).not.toContain(fine);
  });

  it('never suppresses a colleague’s school address', async () => {
    const { messageId } = await compose(sender, { to: [ext('placeholder')], subject: 'internal copy', bodyHtml: '<p>x</p>' });
    const addr = `unknown-${tag}@amashuri.com`;
    const { rows: m } = await getPool().query<{ thread_id: string }>('SELECT thread_id FROM mail_messages WHERE id = $1', [messageId]);
    await getPool().query(
      `INSERT INTO mail_recipients (id, message_id, thread_id, kind, user_id, address, name, channel, delivery_status)
       VALUES ($1,$2,$3,'to',$4,$5,'Colleague','smtp','queued')`, [snowflake(), messageId, m[0]!.thread_id, internal, addr]);
    await deliverSmtp(messageId, env);
    const row = (await rows(messageId)).find((r) => r.address === addr)!;
    expect(row.delivery_status).toBe('bounced');
    expect(await suppressed(addr)).toBe(false);
  });

  it('reclaims a copy stranded in "sending" by a crashed worker', async () => {
    const a = ext('stranded');
    const { messageId } = await compose(sender, { to: [a], subject: 'stranded', bodyHtml: '<p>x</p>' });
    await getPool().query(
      `UPDATE mail_recipients SET delivery_status = 'sending', claimed_at = now() - interval '20 minutes' WHERE message_id = $1`, [messageId]);
    await deliverSmtp(messageId, env);
    expect((await rows(messageId))[0]!.delivery_status).toBe('delivered');
    expect(sink.accepted).toContain(a);
  });
});

describe('recipient caps', () => {
  it('refuses a send that would cross the hourly cap', async () => {
    const caps = { hourly: 50, daily: 100 };
    const used = (await getPool().query<{ n: number }>(
      `SELECT count(DISTINCT (r.message_id, COALESCE(r.user_id, lower(r.address))))::int AS n
         FROM mail_messages m JOIN mail_recipients r ON r.message_id = m.id
        WHERE m.from_user_id = $1 AND m.created_at > now() - interval '1 hour'`, [sender])).rows[0]!.n;
    const room = caps.hourly - used;
    const ok = Array.from({ length: room }, (_, i) => ext(`cap${i}`));
    await expect(compose(sender, { to: ok, subject: 'fill', bodyHtml: '<p>x</p>' }, { recipientCaps: caps })).resolves.toBeTruthy();
    const err = await compose(sender, { to: [ext('one-more')], subject: 'over', bodyHtml: '<p>x</p>' }, { recipientCaps: caps }).catch((e) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err.status).toBe(429);
    // Drafts are never capped.
    await expect(compose(sender, { to: [ext('draft')], subject: 'd', bodyHtml: '<p>x</p>', draft: true }, { recipientCaps: caps })).resolves.toBeTruthy();
  });
});

describe('campaigns', () => {
  it('sends to the list frozen at submission, not whoever was added later', async () => {
    const c = await createCampaign(sender, { subject: 'Frozen', bodyHtml: '<p>hi</p>', listIds: [],
      extraRecipients: [{ address: ext('frozen-a') }] });
    await submitCampaign(sender, c.id);
    // Edited after submission (e.g. through the list behind it): must not widen the send.
    await getPool().query(`UPDATE mail_campaigns SET extra_recipients = $2::jsonb WHERE id = $1`,
      [c.id, JSON.stringify([{ address: ext('frozen-a'), name: 'a', mergeVars: {} }, { address: ext('frozen-late'), name: 'late', mergeVars: {} }])]);
    await runCampaign(c.id);
    const { rows: sent } = await getPool().query<{ address: string }>(
      `SELECT r.address FROM mail_recipients r JOIN mail_messages m ON m.id = r.message_id WHERE m.campaign_id = $1`, [c.id]);
    expect(sent.map((r) => r.address)).toEqual([ext('frozen-a')]);
  });

  it('a campaign another run holds the lease on is left alone; a lapsed lease is resumed', async () => {
    const c = await createCampaign(sender, { subject: 'Leased', bodyHtml: '<p>hi</p>', listIds: [],
      extraRecipients: [{ address: ext('lease-a') }] });
    await submitCampaign(sender, c.id);
    await getPool().query(`UPDATE mail_campaigns SET status = 'sending', lease_until = now() + interval '5 minutes' WHERE id = $1`, [c.id]);
    await runCampaign(c.id);
    const count = async () => (await getPool().query('SELECT count(*)::int AS n FROM mail_messages WHERE campaign_id = $1', [c.id])).rows[0].n;
    expect(await count()).toBe(0);
    await getPool().query(`UPDATE mail_campaigns SET lease_until = now() - interval '1 minute' WHERE id = $1`, [c.id]);
    await runCampaign(c.id);
    expect(await count()).toBe(1);
    // A second run after it finished sends nothing more.
    await runCampaign(c.id);
    expect(await count()).toBe(1);
  });
});
