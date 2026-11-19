/**
 * Connected mailboxes (docs/MAIL_INBOUND_PLAN_2026-11.md §2.1).
 *
 * A person links their own school mailbox so the mail they receive from
 * outside shows in Tupo, and (optionally) so their replies go out as their
 * own address. Three rules hold everything here:
 *
 *  - The password is checked against the real server before it is kept, and
 *    kept only as AES-256-GCM ciphertext. The key (MAIL_ACCOUNT_KEY) lives in
 *    the services' environment, never in the database or in git.
 *  - Only the school's own mail server is accepted (MAIL_IMAP_HOST, or the
 *    relay's SMTP_HOST). Letting a person name any host would turn "connect"
 *    into a way to probe the server's network.
 *  - Nothing ever writes to the person's mailbox: the sync opens it read-only.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { getPool, snowflake } from '@tupo/db';
import type { MailAccountConnectPayload, MailAccountSettings, MailAccountView } from '@tupo/shared';
import { MailError } from './errors.js';
import { bareAddress } from './smtp.js';

/* ── Encryption ──────────────────────────────────────────────────────────── */

function accountKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = (env.MAIL_ACCOUNT_KEY ?? '').trim();
  if (!raw) return null;
  // Any string works; 64 hex characters are used as-is.
  return /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : createHash('sha256').update(raw).digest();
}

export function encryptSecret(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = accountKey(env);
  if (!key) throw new MailError('Connecting a mailbox is not set up on this server yet.', 503);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
}

export function decryptSecret(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = accountKey(env);
  if (!key) throw new Error('MAIL_ACCOUNT_KEY is not set');
  if (!stored.startsWith('v1:')) throw new Error('unknown secret format');
  const buf = Buffer.from(stored.slice(3), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/* ── The school's mail server ────────────────────────────────────────────── */

export interface MailServerConfig {
  /** The mailbox server tried first (shown to people). */
  imapHost: string | null;
  imapPort: number;
  imapSecure: boolean;
  /** Sending as a person: this host when set, otherwise the mailbox server that accepted their login. */
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  /**
   * Hosts a person may connect to, in the order they are tried. A school's
   * provider can run more than one: NGA's relay (mail.hackflix.net) is the
   * incoming exchanger and refuses mailbox logins, while the mailboxes live on
   * mail.supremecenter.com. Trying the list means one wrong guess in the
   * settings does not lock everyone out.
   */
  allowedHosts: string[];
  domain: string | null;
}

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : /^(1|true|on|yes)$/i.test(v.trim()));

export function mailServerConfig(env: NodeJS.ProcessEnv = process.env): MailServerConfig {
  const imapHost = (env.MAIL_IMAP_HOST || env.SMTP_HOST || '').trim() || null;
  const imapPort = parseInt(env.MAIL_IMAP_PORT ?? '', 10) || 993;
  const smtpHost = (env.MAIL_ACCOUNT_SMTP_HOST || '').trim() || null;
  const smtpPort = parseInt(env.MAIL_ACCOUNT_SMTP_PORT ?? '', 10) || 465;
  const from = env.MAIL_FROM || env.SMTP_USER || '';
  const domain = (env.MAIL_ACCOUNT_DOMAIN || bareAddress(from).split('@')[1] || '').trim().toLowerCase() || null;
  const extra = (env.MAIL_IMAP_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return {
    imapHost, imapPort,
    imapSecure: bool(env.MAIL_IMAP_SECURE, imapPort === 993),
    smtpHost, smtpPort,
    smtpSecure: bool(env.MAIL_ACCOUNT_SMTP_SECURE, smtpPort === 465),
    allowedHosts: [...new Set([...(imapHost ? [imapHost.toLowerCase()] : []), ...extra])],
    domain,
  };
}

export function replyCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return bool(env.MAIL_REPLY_CAPTURE, false);
}

/* ── Checking credentials against the server ─────────────────────────────── */

export interface ImapLogin { host: string; port: number; secure: boolean; user: string; pass: string }

export function imapClient(l: ImapLogin): ImapFlow {
  return new ImapFlow({
    host: l.host, port: l.port, secure: l.secure,
    auth: { user: l.user, pass: l.pass },
    logger: false,
    // A school server with a certificate for another name is still the
    // school's server; plain-text ports are refused unless configured.
    tls: { rejectUnauthorized: !bool(process.env.MAIL_IMAP_INSECURE_TLS, false) },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 120_000,
    disableAutoIdle: true,
  });
}

export type ImapLoginCheck =
  | { ok: true }
  | { ok: false; kind: 'auth' | 'unreachable' | 'other'; message: string; detail: string };

/** Log in and out. Says why it failed, in words for the person and in detail for the log. */
export async function checkImapLogin(l: ImapLogin): Promise<ImapLoginCheck> {
  const client = imapClient(l);
  client.on('error', () => { /* reported through the promise */ });
  try {
    await client.connect();
    await client.logout().catch(() => {});
    return { ok: true };
  } catch (e) {
    const err = e as { authenticationFailed?: boolean; code?: string; message?: string; responseText?: string; serverResponseCode?: string };
    client.close();
    const detail = [err.code, err.serverResponseCode, err.responseText, err.message].filter(Boolean).join(' | ').slice(0, 300);
    if (err.authenticationFailed || /auth|login|credentials|password/i.test(`${err.responseText ?? ''} ${err.message ?? ''}`)) {
      return { ok: false, kind: 'auth', message: 'The email address or password is not right.', detail };
    }
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || /timeout/i.test(err.message ?? '')) {
      return { ok: false, kind: 'unreachable', message: 'The mail server could not be reached. Try again in a moment.', detail };
    }
    return { ok: false, kind: 'other', message: `The mail server refused the connection${err.message ? ` (${err.message.slice(0, 120)})` : ''}.`, detail };
  }
}

export async function checkSmtpLogin(host: string, port: number, secure: boolean, user: string, pass: string): Promise<boolean> {
  const t = nodemailer.createTransport({ host, port, secure, auth: { user, pass }, connectionTimeout: 15_000 });
  try { await t.verify(); return true; } catch { return false; } finally { t.close(); }
}

/* ── Rows ────────────────────────────────────────────────────────────────── */

export interface MailAccountRow {
  id: string; user_id: string; address: string; username: string; secret_enc: string;
  imap_host: string; imap_port: number; imap_secure: boolean;
  smtp_host: string | null; smtp_port: number | null; smtp_secure: boolean;
  send_as: boolean; status: 'active' | 'error' | 'paused'; last_error: string | null;
  last_sync_at: string | null; uid_validity: string | null; last_uid: string; imported_count: number;
  created_at: string;
}

function toView(r: MailAccountRow): MailAccountView {
  return {
    address: r.address, username: r.username, imapHost: r.imap_host, imapPort: r.imap_port,
    sendAs: r.send_as, canSend: Boolean(r.smtp_host), status: r.status, lastError: r.last_error,
    lastSyncAt: r.last_sync_at, importedCount: r.imported_count, createdAt: r.created_at,
  };
}

export async function accountRowFor(userId: string): Promise<MailAccountRow | null> {
  const { rows } = await getPool().query<MailAccountRow>(`SELECT * FROM mail_accounts WHERE user_id = $1`, [userId]);
  return rows[0] ?? null;
}

export async function mailAccountSettings(userId: string, env: NodeJS.ProcessEnv = process.env): Promise<MailAccountSettings> {
  const cfg = mailServerConfig(env);
  const row = await accountRowFor(userId);
  const unavailableReason = !cfg.imapHost ? 'This server has no mail server set up.'
    : !accountKey(env) ? 'Connecting a mailbox is not set up on this server yet.'
    : null;
  return {
    available: !unavailableReason, unavailableReason,
    imapHost: cfg.imapHost, imapPort: cfg.imapPort, domain: cfg.domain,
    replyCapture: replyCaptureEnabled(env),
    account: row ? toView(row) : null,
  };
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/**
 * Connect (or reconnect) a mailbox. The password is checked against the
 * server first; a wrong one is refused and nothing is stored.
 */
export async function connectMailAccount(
  userId: string, payload: MailAccountConnectPayload, env: NodeJS.ProcessEnv = process.env,
): Promise<MailAccountView> {
  const cfg = mailServerConfig(env);
  if (!cfg.imapHost) throw new MailError('This server has no mail server set up.', 503);
  if (!accountKey(env)) throw new MailError('Connecting a mailbox is not set up on this server yet.', 503);
  const address = String(payload.address ?? '').trim().toLowerCase();
  const password = String(payload.password ?? '');
  const username = String(payload.username ?? '').trim() || address;
  if (!EMAIL.test(address) || address.length > 254) throw new MailError('Enter your full email address.');
  if (!password || password.length > 512) throw new MailError('Enter your email password.');
  // Each allowed mailbox server in turn; the first that accepts the login is
  // the person's. Refusals are logged with the server's own words (never the
  // password), so a wrong server setting is visible in the logs.
  let accepted: string | null = null;
  const failures: Array<Extract<ImapLoginCheck, { ok: false }>> = [];
  for (const host of cfg.allowedHosts) {
    const r = await checkImapLogin({ host, port: cfg.imapPort, secure: cfg.imapSecure, user: username, pass: password });
    if (r.ok) { accepted = host; break; }
    console.warn(`[mail] mailbox login for ${address} refused by ${host}: ${r.detail}`);
    failures.push(r);
  }
  if (!accepted) {
    const shown = failures.find((f) => f.kind === 'auth') ?? failures.find((f) => f.kind === 'other') ?? failures[0];
    throw new MailError(shown?.message ?? 'The mail server could not be reached.', 400);
  }
  // Sending as the person needs their SMTP login too: on the configured host,
  // or the mailbox server that just accepted them. A refusal only turns
  // "send from my address" off; receiving still works.
  const smtpHost = cfg.smtpHost ?? accepted;
  const canSend = await checkSmtpLogin(smtpHost, cfg.smtpPort, cfg.smtpSecure, username, password);

  const secret = encryptSecret(password, env);
  const { rows } = await getPool().query<MailAccountRow>(
    `INSERT INTO mail_accounts (id, user_id, address, username, secret_enc, imap_host, imap_port, imap_secure,
                                smtp_host, smtp_port, smtp_secure, send_as, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active')
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET
       address = EXCLUDED.address, username = EXCLUDED.username, secret_enc = EXCLUDED.secret_enc,
       imap_host = EXCLUDED.imap_host, imap_port = EXCLUDED.imap_port, imap_secure = EXCLUDED.imap_secure,
       smtp_host = EXCLUDED.smtp_host, smtp_port = EXCLUDED.smtp_port, smtp_secure = EXCLUDED.smtp_secure,
       send_as = EXCLUDED.send_as, status = 'active', last_error = NULL, updated_at = now(),
       -- Another address is another mailbox: start its position afresh.
       uid_validity = CASE WHEN mail_accounts.address = EXCLUDED.address THEN mail_accounts.uid_validity END,
       last_uid = CASE WHEN mail_accounts.address = EXCLUDED.address THEN mail_accounts.last_uid ELSE 0 END
     RETURNING *`,
    [snowflake(), userId, address, username, secret, accepted, cfg.imapPort, cfg.imapSecure,
     canSend ? smtpHost : null, canSend ? cfg.smtpPort : null, cfg.smtpSecure,
     canSend && payload.sendAs !== false],
  );
  return toView(rows[0]!);
}

export async function updateMailAccount(userId: string, patch: { sendAs?: boolean; paused?: boolean }): Promise<MailAccountView> {
  const row = await accountRowFor(userId);
  if (!row) throw new MailError('No mailbox is connected.', 404);
  const sendAs = patch.sendAs === undefined ? row.send_as : patch.sendAs && Boolean(row.smtp_host);
  const status = patch.paused === undefined ? row.status : patch.paused ? 'paused' : 'active';
  const { rows } = await getPool().query<MailAccountRow>(
    `UPDATE mail_accounts SET send_as = $2, status = $3, updated_at = now(),
            last_error = CASE WHEN $3 = 'active' THEN NULL ELSE last_error END
      WHERE user_id = $1 RETURNING *`, [userId, sendAs, status]);
  return toView(rows[0]!);
}

/**
 * Disconnect: the password is deleted at once. Imported mail stays unless
 * `purge` — then the person's copies of it go (threads others share stay).
 */
export async function disconnectMailAccount(userId: string, opts: { purge?: boolean } = {}): Promise<{ removed: number }> {
  const pool = getPool();
  await pool.query(`DELETE FROM mail_accounts WHERE user_id = $1`, [userId]);
  if (!opts.purge) return { removed: 0 };
  const { rowCount } = await pool.query(
    `DELETE FROM mail_messages m WHERE m.source = 'imap' AND m.from_user_id IS NULL
        AND m.metadata->>'importedFor' = $1`, [userId]);
  await pool.query(`DELETE FROM mail_inbound_seen WHERE user_id = $1`, [userId]);
  // Threads left with no message at all.
  await pool.query(`DELETE FROM mail_threads t WHERE NOT EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = t.id)`);
  return { removed: rowCount ?? 0 };
}

/** The person's own SMTP login, when they chose to send as their address. */
export async function sendAsLogin(
  userId: string, env: NodeJS.ProcessEnv = process.env,
): Promise<{ host: string; port: number; secure: boolean; user: string; pass: string; address: string } | null> {
  const row = await accountRowFor(userId);
  if (!row || !row.send_as || !row.smtp_host || row.status === 'paused') return null;
  try {
    return {
      host: row.smtp_host, port: row.smtp_port ?? 465, secure: row.smtp_secure,
      user: row.username, pass: decryptSecret(row.secret_enc, env), address: row.address,
    };
  } catch {
    return null;
  }
}
