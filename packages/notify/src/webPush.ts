/**
 * Web push (F-04): notifications for a closed tab or the installed app.
 *
 * Sent only to people with no live connection — someone with the app open
 * already gets the toast and the bell, and a second, system-level copy of the
 * same thing is noise. Respects the desktop-notification preference and quiet
 * hours (in the person's own time zone). A subscription the push service says
 * is gone (404/410) is deleted; one that keeps failing is dropped after a few.
 *
 * Needs VAPID keys (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT);
 * without them push is simply off and the rest of the app is unaffected.
 */
import webpush from 'web-push';
import type { Redis } from 'ioredis';
import { getPool, snowflake } from '@tupo/db';
import { presenceKey } from '@tupo/shared';

export interface PushConfig { publicKey: string; privateKey: string; subject: string }

export function pushConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PushConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: env.VAPID_SUBJECT?.trim() || 'mailto:support@amashuri.com' };
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function saveSubscription(userId: string, sub: PushSubscriptionInput, userAgent?: string | null): Promise<void> {
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000) throw new Error('Invalid push subscription.');
  if (!sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Invalid push subscription.');
  // The endpoint identifies the browser; if another account signed in on it,
  // it now belongs to this one.
  await getPool().query(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent, failures = 0`,
    [snowflake(), userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 300) ?? null],
  );
}

export async function removeSubscription(userId: string, endpoint: string): Promise<void> {
  await getPool().query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
}

/** Every subscription of a person (sign-out on all devices removes them). */
export async function removeAllSubscriptions(userId: string): Promise<void> {
  await getPool().query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
}

interface PushRow { user_id: string; kind: string; title: string; body: string | null; link: string | null; id: string; subject_id: string | null }

/** Local minutes-from-midnight in a time zone (falls back to server time). */
function localMinutes(tz: string | null, now = new Date()): number {
  try {
    if (tz) {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
      const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
      const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
      return h * 60 + m;
    }
  } catch { /* unknown zone */ }
  return now.getHours() * 60 + now.getMinutes();
}

function inQuiet(from: number | null, to: number | null, minutes: number): boolean {
  if (from === null || to === null || from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/**
 * Send these notifications as web push to whoever is offline. Best effort:
 * never throws, never slows the caller beyond the sends themselves.
 */
export async function sendWebPush(
  rows: PushRow[], presence: Redis | null, config: PushConfig | null = pushConfigFromEnv(),
): Promise<{ sent: number; skipped: number }> {
  if (!config || !rows.length) return { sent: 0, skipped: rows.length };
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  // Online somewhere? Then the app itself tells them.
  let online = new Set<string>();
  if (presence) {
    try {
      const vals = await presence.mget(userIds.map(presenceKey));
      online = new Set(userIds.filter((_, i) => vals[i]));
    } catch { /* treat as offline */ }
  }
  const offline = userIds.filter((id) => !online.has(id));
  if (!offline.length) return { sent: 0, skipped: rows.length };

  const { rows: prefs } = await getPool().query<{
    user_id: string; desktop_notifications: boolean; quiet_from_minute: number | null; quiet_to_minute: number | null; timezone: string | null;
  }>('SELECT user_id, desktop_notifications, quiet_from_minute, quiet_to_minute, timezone FROM user_chat_prefs WHERE user_id = ANY($1::text[])', [offline]);
  const prefOf = new Map(prefs.map((p) => [p.user_id, p]));
  const allowed = new Set(offline.filter((id) => {
    const p = prefOf.get(id);
    if (!p) return true;
    if (!p.desktop_notifications) return false;
    return !inQuiet(p.quiet_from_minute, p.quiet_to_minute, localMinutes(p.timezone));
  }));
  if (!allowed.size) return { sent: 0, skipped: rows.length };

  const { rows: subs } = await getPool().query<{ id: string; user_id: string; endpoint: string; p256dh: string; auth: string }>(
    'SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::text[])', [[...allowed]]);
  let sent = 0;
  await Promise.all(rows.filter((r) => allowed.has(r.user_id)).flatMap((r) =>
    subs.filter((s) => s.user_id === r.user_id).map(async (s) => {
      const payload = JSON.stringify({
        title: r.title, body: r.body ?? '', link: r.link ?? '/app',
        // Same tag = the OS replaces rather than stacks (a busy conversation).
        tag: `${r.kind}:${r.subject_id ?? r.id}`, id: r.id,
      });
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: r.kind === 'chat.dm' || r.kind === 'chat.mention' ? 'high' : 'normal' });
        sent++;
        await getPool().query('UPDATE push_subscriptions SET last_success_at = now(), failures = 0 WHERE id = $1', [s.id]);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await getPool().query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]).catch(() => {});
        } else {
          await getPool().query(
            `UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1;`, [s.id]).catch(() => {});
          await getPool().query('DELETE FROM push_subscriptions WHERE id = $1 AND failures >= 5', [s.id]).catch(() => {});
        }
      }
    })));
  return { sent, skipped: rows.length - sent };
}
