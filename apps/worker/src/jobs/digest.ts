/**
 * The email digest (F-04): mentions and direct messages someone has not seen,
 * by email, for the person who has not opened Tupo in a while.
 *
 * Hourly. Picks notifications that are still unread after 30 minutes, were
 * never emailed, belong to someone who has not opted out and is not online
 * right now, and sends one email per person with up to 20 of them. Each
 * notification goes into at most one email (`emailed_at`). Nothing to send,
 * no email; no SMTP relay configured, nothing happens at all.
 */
import { Redis } from 'ioredis';
import { getPool } from '@tupo/db';
import { presenceKey } from '@tupo/shared';
import { sendSmtp, smtpConfigFromEnv, type SmtpConfig } from '@tupo/mail';

const DIGEST_KINDS = ['chat.dm', 'chat.mention', 'feed.mention', 'meet.invited'];
const MAX_PEOPLE = 200;
const MAX_ITEMS = 20;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

interface Item { id: string; title: string; body: string | null; link: string | null; created_at: Date }

export function renderDigest(name: string, items: Item[], base: string): { subject: string; html: string; text: string } {
  const n = items.length;
  const subject = n === 1 ? `You have 1 unread message on Tupo` : `You have ${n} unread messages on Tupo`;
  const url = (link: string | null) => `${base}${link && link.startsWith('/') ? link : '/app'}`;
  const rows = items.map((i) => `
      <tr><td style="padding:10px 0;border-bottom:1px solid #eef0f4">
        <a href="${esc(url(i.link))}" style="color:#0f172a;text-decoration:none;font-weight:600">${esc(i.title)}</a>
        ${i.body ? `<div style="color:#475569;font-size:14px;margin-top:2px">${esc(i.body.slice(0, 200))}</div>` : ''}
      </td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7fb;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:16px;padding:24px" cellpadding="0" cellspacing="0">
      <tr><td style="font-size:18px;font-weight:700;color:#0f172a">Hi ${esc(name.split(' ')[0] || name)}, here is what you missed</td></tr>
      <tr><td style="padding-top:4px;color:#64748b;font-size:14px">${esc(subject.replace('You have', 'You have'))}</td></tr>
      <tr><td style="padding-top:12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
      <tr><td style="padding-top:20px"><a href="${esc(`${base}/app`)}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600;display:inline-block">Open Tupo</a></td></tr>
      <tr><td style="padding-top:20px;color:#94a3b8;font-size:12px">You get this when you have unread mentions or direct messages. Turn it off in Tupo → Chat → Notification settings.</td></tr>
    </table>
  </td></tr></table></body></html>`;
  const text = [`Hi ${name}, here is what you missed on Tupo:`, '',
    ...items.map((i) => `• ${i.title}${i.body ? ` — ${i.body.slice(0, 140)}` : ''}\n  ${url(i.link)}`), '',
    `Open Tupo: ${base}/app`, '', 'Turn these emails off in Tupo → Chat → Notification settings.'].join('\n');
  return { subject, html, text };
}

export async function runEmailDigest(
  env: NodeJS.ProcessEnv = process.env, cfg: SmtpConfig | null = smtpConfigFromEnv(env),
): Promise<{ people: number; emails: number }> {
  if (!cfg) return { people: 0, emails: 0 };
  const base = (env.APP_PUBLIC_URL || 'http://localhost:5194').replace(/\/$/, '');
  const pool = getPool();

  const { rows: candidates } = await pool.query<{ user_id: string; name: string; email: string }>(
    `SELECT DISTINCT n.user_id, u.name, u.email
       FROM notifications n
       JOIN users u ON u.id = n.user_id AND u.status = 'active'
       LEFT JOIN user_chat_prefs p ON p.user_id = n.user_id
      WHERE n.read_at IS NULL AND n.emailed_at IS NULL
        AND n.kind = ANY($1::text[])
        AND n.created_at BETWEEN now() - interval '1 day' AND now() - interval '30 minutes'
        AND COALESCE(p.email_digest, true)
        AND u.email LIKE '%@%'
      LIMIT $2`,
    [DIGEST_KINDS, MAX_PEOPLE],
  );
  if (!candidates.length) return { people: 0, emails: 0 };

  // Online right now? Then they will see it in the app.
  let online = new Set<string>();
  const redis = new Redis(env.REDIS_URL ?? 'redis://127.0.0.1:6379/0', { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    const vals = await redis.mget(candidates.map((c) => presenceKey(c.user_id)));
    online = new Set(candidates.filter((_, i) => vals[i]).map((c) => c.user_id));
  } catch { /* unknown: treat as offline */ } finally { redis.disconnect(); }

  let emails = 0;
  for (const person of candidates.filter((c) => !online.has(c.user_id))) {
    const { rows: items } = await pool.query<Item>(
      `SELECT id, title, body, link, created_at FROM notifications
        WHERE user_id = $1 AND read_at IS NULL AND emailed_at IS NULL AND kind = ANY($2::text[])
          AND created_at BETWEEN now() - interval '1 day' AND now() - interval '30 minutes'
        ORDER BY created_at DESC LIMIT $3`,
      [person.user_id, DIGEST_KINDS, MAX_ITEMS],
    );
    if (!items.length) continue;
    const mail = renderDigest(person.name, items, base);
    const result = await sendSmtp(cfg, { to: person.email, toName: person.name, fromName: 'Tupo', ...mail });
    if (result.ok) {
      emails++;
      await pool.query('UPDATE notifications SET emailed_at = now() WHERE id = ANY($1::text[])', [items.map((i) => i.id)]);
    } else if (result.failure === 'transport') {
      // The relay is down: stop, the next run tries again.
      console.error('[worker] digest: SMTP relay failing —', result.error);
      break;
    }
  }
  return { people: candidates.length, emails };
}
