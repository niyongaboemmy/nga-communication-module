import { PRIMARY_TENANT_ID, effectiveTid } from '@tupo/tenancy';
/**
 * What an email copy needs beyond its body: the attachments' bytes, the
 * headers that thread it in the recipient's mail app, and a one-click
 * unsubscribe for bulk mail.
 *
 * The bytes live behind tupo-files. The worker reads them over the loopback
 * internal route with FILES_INTERNAL_SECRET; with no secret configured the
 * email says the attachments are in Tupo instead of silently dropping them.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPool } from '@tupo/db';

/** Total attachment size an email may carry; most relays refuse ~20-25 MB. */
const DEFAULT_ATTACH_MAX_BYTES = 15 * 1024 * 1024;

export interface EmailAttachments {
  attachments: Array<{ filename: string; content: Buffer; contentType: string }>;
  /** Attachments that could not go by email, with why. */
  omitted: Array<{ name: string; size: number; why: 'too_large' | 'unavailable' }>;
}

export async function emailAttachments(
  messageId: string, env: NodeJS.ProcessEnv = process.env,
): Promise<EmailAttachments> {
  const { rows } = await getPool().query<{ file_id: string; name: string; mime: string; size: string }>(
    // The stored size, not the one the composer declared.
    `SELECT a.file_id, a.name, a.mime, f.size_bytes AS size
       FROM mail_attachments a JOIN files f ON f.id = a.file_id
      WHERE a.message_id = $1 ORDER BY a.ordinal`, [messageId]);
  const out: EmailAttachments = { attachments: [], omitted: [] };
  if (!rows.length) return out;

  const max = parseInt(env.MAIL_EMAIL_ATTACH_MAX_BYTES ?? '', 10) || DEFAULT_ATTACH_MAX_BYTES;
  const base = (env.FILES_INTERNAL_URL || 'http://127.0.0.1:5192').replace(/\/$/, '');
  const secret = env.FILES_INTERNAL_SECRET ?? '';
  let used = 0;
  for (const a of rows) {
    const size = Number(a.size) || 0;
    if (used + size > max) { out.omitted.push({ name: a.name, size, why: 'too_large' }); continue; }
    if (!secret) { out.omitted.push({ name: a.name, size, why: 'unavailable' }); continue; }
    try {
      const res = await fetch(`${base}/internal/files/${encodeURIComponent(a.file_id)}/content`, {
        headers: { 'x-internal-secret': secret }, signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`files answered ${res.status}`);
      const content = Buffer.from(await res.arrayBuffer());
      used += content.length;
      out.attachments.push({ filename: a.name, content, contentType: a.mime || 'application/octet-stream' });
    } catch (e) {
      console.error(`[mail] attachment ${a.file_id} of ${messageId} could not be read:`, (e as Error).message);
      out.omitted.push({ name: a.name, size, why: 'unavailable' });
    }
  }
  return out;
}

/** A line for the email body naming what could not be attached. */
export function omittedNote(omitted: EmailAttachments['omitted']): { text: string; html: string } | null {
  if (!omitted.length) return null;
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const list = omitted.map((o) => `${o.name}${o.size ? ` (${mb(o.size)})` : ''}`);
  const lead = omitted.some((o) => o.why === 'too_large')
    ? 'Too large to send by email, open them in Tupo or ask the sender:'
    : 'Could not be attached to this email, open them in Tupo or ask the sender:';
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return {
    text: `\n\n--\n${lead}\n${list.map((l) => `  - ${l}`).join('\n')}`,
    html: `<hr><p style="color:#555;font-size:13px">${esc(lead)}</p><ul style="color:#555;font-size:13px">${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`,
  };
}

/** `<id@domain>`: the same for every copy and every retry of one message. */
export const emailMessageId = (id: string, domain: string) => `<${id}@${domain}>`;

/** In-Reply-To and References from the earlier messages in the thread. */
export async function threadHeaders(
  messageId: string, domain: string,
): Promise<{ inReplyTo?: string; references: string[] }> {
  const { rows } = await getPool().query<{ id: string; parent_id: string | null }>(
    `SELECT p.id, m.parent_id
       FROM mail_messages m
       JOIN mail_messages p ON p.thread_id = m.thread_id AND p.id <> m.id
                           AND NOT p.is_draft AND p.created_at <= m.created_at
      WHERE m.id = $1
      ORDER BY p.created_at DESC
      LIMIT 20`, [messageId]);
  if (!rows.length) return { references: [] };
  const references = rows.map((r) => emailMessageId(r.id, domain)).reverse();
  const parent = rows[0]!.parent_id && rows.some((r) => r.id === rows[0]!.parent_id) ? rows[0]!.parent_id : rows[0]!.id;
  return { inReplyTo: emailMessageId(parent, domain), references };
}

/* ── One-click unsubscribe (RFC 8058) ─────────────────────────────────── */

const b64url = (s: string) => Buffer.from(s).toString('base64url');
// The school is part of what is signed (multi-tenancy: a suppression belongs
// to one tenant). Tenant 1 keeps the original form, so links already sent
// keep working.
const sign = (address: string, secret: string, tid = PRIMARY_TENANT_ID) =>
  createHmac('sha256', secret)
    .update(tid === PRIMARY_TENANT_ID ? `unsubscribe:${address.toLowerCase()}` : `unsubscribe:t${tid}:${address.toLowerCase()}`)
    .digest('base64url');

/** The link, or null when MAIL_LINK_SECRET or APP_PUBLIC_URL is not set. */
export function unsubscribeUrl(address: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.MAIL_LINK_SECRET;
  const base = env.APP_PUBLIC_URL?.replace(/\/$/, '');
  if (!secret || !base) return null;
  const tid = effectiveTid('unsubscribe link');
  const scope = tid === PRIMARY_TENANT_ID ? '' : `&tid=${tid}`;
  return `${base}/api/mail/unsubscribe?a=${b64url(address.toLowerCase())}&t=${sign(address, secret, tid)}${scope}`;
}

/** The address a link was made for, or null if the link is not genuine. */
export function verifyUnsubscribe(a: string, t: string, env: NodeJS.ProcessEnv = process.env, tid = PRIMARY_TENANT_ID): string | null {
  const secret = env.MAIL_LINK_SECRET;
  if (!secret || !a || !t) return null;
  let address: string;
  try { address = Buffer.from(a, 'base64url').toString('utf8'); } catch { return null; }
  if (!/^[^\s@]+@[^\s@]+$/.test(address)) return null;
  const want = Buffer.from(sign(address, secret, tid));
  const given = Buffer.from(t);
  return want.length === given.length && timingSafeEqual(want, given) ? address.toLowerCase() : null;
}
