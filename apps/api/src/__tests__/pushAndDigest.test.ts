import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import net from 'node:net';
import webpush from 'web-push';
import { Redis } from 'ioredis';
import { getPool, closeDb, seedRbac, snowflake } from '@tupo/db';
import { notify, sendWebPush } from '@tupo/notify';
import { app } from '../app.js';
import { config } from '../config.js';
import { runEmailDigest } from '@tupo/mail';

/** F-04: push subscriptions, who gets a push, and the email digest. */

async function user(name: string) {
  const id = snowflake();
  const { rows } = await getPool().query<{ id: number }>(`SELECT id FROM roles WHERE name = 'Staff'`);
  await getPool().query(`INSERT INTO users (id, mis_user_id, name, email, role, role_id) VALUES ($1,$1,$2,$3,'staff',$4)`,
    [id, name, `${id}@outside.example`, rows[0]!.id]);
  users.push(id);
  return { id, email: `${id}@outside.example`, token: jwt.sign({ id, misUserId: id, name, email: `${id}@outside.example`, role: 'staff' }, config.jwtSecret) };
}
const as = (t: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${t}`),
  post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
  del: (p: string, b?: unknown) => request(app).delete(p).set('Authorization', `Bearer ${t}`).send(b ?? {}),
});
const users: string[] = [];
const keys = webpush.generateVAPIDKeys();
const sub = (n: number) => ({ endpoint: `https://127.0.0.1:1/push/${n}-${snowflake()}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0');

beforeAll(async () => { await seedRbac(getPool()); });
afterAll(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM push_subscriptions WHERE user_id = ANY($1::text[])', [users]);
  await pool.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [users]);
  await pool.query('DELETE FROM user_chat_prefs WHERE user_id = ANY($1::text[])', [users]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  for (const id of users) await redis.del(`presence:${id}`);
  redis.disconnect();
  await closeDb();
});

describe('subscriptions', () => {
  it('push is off without VAPID keys, and says so', async () => {
    delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;
    const u = await user('NoKeys');
    expect((await as(u.token).get('/api/push/config')).body.data).toEqual({ enabled: false, publicKey: null });
    expect((await as(u.token).post('/api/push/subscriptions', { subscription: sub(0) })).status).toBe(503);
  });

  it('stores a valid subscription, refuses a bad one, and forgets one on request', async () => {
    process.env.VAPID_PUBLIC_KEY = keys.publicKey; process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    const u = await user('Keys');
    expect((await as(u.token).get('/api/push/config')).body.data.publicKey).toBe(keys.publicKey);
    expect((await as(u.token).post('/api/push/subscriptions', { subscription: { endpoint: 'http://insecure', keys: {} } })).status).toBe(400);
    const s = sub(1);
    expect((await as(u.token).post('/api/push/subscriptions', { subscription: s })).status).toBe(201);
    const count = async () => (await getPool().query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [u.id])).rows[0].n;
    expect(await count()).toBe(1);
    await as(u.token).del('/api/push/subscriptions', { endpoint: s.endpoint });
    expect(await count()).toBe(0);
  });
});

describe('who gets a push', () => {
  it('only people offline who allow desktop notifications; failures are counted', async () => {
    process.env.VAPID_PUBLIC_KEY = keys.publicKey; process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    const away = await user('Away');
    const here = await user('Here');
    const muted = await user('Muted');
    for (const [u, n] of [[away, 2], [here, 3], [muted, 4]] as const) await as(u.token).post('/api/push/subscriptions', { subscription: sub(n) });
    await redis.set(`presence:${here.id}`, 'online', 'EX', 60);
    await getPool().query(`INSERT INTO user_chat_prefs (user_id, desktop_notifications) VALUES ($1, false)`, [muted.id]);
    const rows = [
      ...(await notify([away.id], { kind: 'chat.dm', title: 'x', subjectType: 't', subjectId: 'a' })),
      ...(await notify([here.id], { kind: 'chat.dm', title: 'x', subjectType: 't', subjectId: 'b' })),
      ...(await notify([muted.id], { kind: 'chat.dm', title: 'x', subjectType: 't', subjectId: 'c' })),
    ];
    await sendWebPush(rows, redis);
    const failures = async (id: string) => (await getPool().query('SELECT failures FROM push_subscriptions WHERE user_id = $1', [id])).rows[0]?.failures;
    // The endpoint is unreachable, so an attempt shows up as a failure.
    expect(await failures(away.id)).toBe(1);
    expect(await failures(here.id)).toBe(0);
    expect(await failures(muted.id)).toBe(0);
  });
});

/** A scripted SMTP relay that records who was mailed. */
function relay() {
  const accepted: string[] = []; const bodies: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock); sock.on('close', () => sockets.delete(sock)); sock.on('error', () => {});
    let buf = ''; let inData = false; let rcpt: string[] = [];
    sock.write('220 relay.test ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf(inData ? '\r\n.\r\n' : '\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + (inData ? 5 : 2));
        if (inData) { inData = false; accepted.push(...rcpt); bodies.push(line); rcpt = []; sock.write('250 OK\r\n'); continue; }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250-relay.test\r\n250 OK\r\n');
        else if (up.startsWith('RCPT TO')) { rcpt.push(line.slice(line.indexOf('<') + 1, line.indexOf('>'))); sock.write('250 OK\r\n'); }
        else if (up.startsWith('DATA')) { inData = true; sock.write('354 go\r\n'); }
        else if (up.startsWith('QUIT')) { sock.write('221 Bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  return new Promise<{ port: number; accepted: string[]; bodies: string[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, accepted, bodies,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) }));
  });
}

describe('email digest', () => {
  it('emails unseen mentions once, to people away who have not opted out', async () => {
    const sink = await relay();
    const env = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.port), SMTP_SECURE: 'false', MAIL_FROM: 'tupo@amashuri.com',
      MAIL_SMTP_RATE_PER_MIN: '1000', APP_PUBLIC_URL: 'https://tupo.example', REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0' };
    try {
      const away = await user('Digest Away');
      const optedOut = await user('Digest Off');
      const online = await user('Digest Online');
      const fresh = await user('Digest Fresh');
      await getPool().query(`INSERT INTO user_chat_prefs (user_id, email_digest) VALUES ($1, false)`, [optedOut.id]);
      await redis.set(`presence:${online.id}`, 'online', 'EX', 60);
      for (const u of [away, optedOut, online, fresh]) {
        await notify([u.id], { kind: 'chat.mention', title: 'Ann mentioned you', body: 'about <b>exams</b>', link: '/app/chat?c=1', subjectType: 'conversation', subjectId: `d-${u.id}` });
      }
      // Old enough to count, except for "fresh".
      await getPool().query(`UPDATE notifications SET created_at = now() - interval '2 hours' WHERE user_id = ANY($1::text[])`, [[away.id, optedOut.id, online.id]]);

      const r = await runEmailDigest(env as NodeJS.ProcessEnv);
      expect(r.emails).toBe(1);
      expect(sink.accepted).toEqual([away.email]);
      expect(sink.bodies[0]).toContain('Ann mentioned you');
      // The HTML part carries it escaped, never as markup (quoted-printable may
      // encode the ampersand, so look for the escaped tag either way).
      expect(sink.bodies[0]).toMatch(/&(amp;)?lt;b&(amp;)?gt;exams|=26lt;b=26gt;exams|&lt;b&gt;exams/);
      expect(sink.bodies[0]).toMatch(/https:\/\/tupo\.example\/app\/chat\?c=(3D)?1/);

      const again = await runEmailDigest(env as NodeJS.ProcessEnv);
      expect(again.emails).toBe(0);   // each notification at most once
    } finally {
      await sink.close();
    }
  });
});
