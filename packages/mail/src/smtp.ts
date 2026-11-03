/**
 * The SMTP relay (FR-MAIL-7).
 *
 * Nodemailer over the institutional relay configured in the worker's env. The
 * transport is created lazily and reused; a missing configuration is not an
 * error at import time — internal-only deployments never touch this path — but
 * an attempt to actually send without it is.
 *
 * DKIM/SPF/DMARC alignment is a property of the relay and the DNS for
 * `MAIL_FROM`'s domain, not of this code: we simply hand a well-formed message
 * to a relay that is authorised to sign for that domain.
 */
import nodemailer, { type Transporter } from 'nodemailer';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  /** FR-MAIL-7: messages per minute the relay accepts from us. */
  ratePerMin: number;
}

export function smtpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST;
  if (!host) return null;
  const port = parseInt(env.SMTP_PORT ?? '587', 10);
  return {
    host,
    port,
    // 465 is implicit TLS; anything else upgrades with STARTTLS.
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM || env.EMAIL_FROM || (env.SMTP_USER ?? 'no-reply@localhost'),
    ratePerMin: Math.max(1, parseInt(env.MAIL_SMTP_RATE_PER_MIN ?? '60', 10) || 60),
  };
}

let transporter: Transporter | null = null;
let cachedKey = '';

export function getTransport(cfg: SmtpConfig): Transporter {
  const key = `${cfg.host}:${cfg.port}:${cfg.user ?? ''}:${cfg.ratePerMin}`;
  if (transporter && cachedKey === key) return transporter;
  transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    // FR-MAIL-7: per-minute rate limiting at the transport (MAIL_SMTP_RATE_PER_MIN).
    rateDelta: 60_000,
    rateLimit: cfg.ratePerMin,
  });
  cachedKey = key;
  return transporter;
}

export interface OutboundMail {
  to: string;
  toName?: string;
  fromName: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
}

/**
 * Why a send failed, which decides what happens next (MAIL-H5):
 *   recipient — the relay refused this address (RCPT 5.1.x etc.): bounce and
 *               suppress it (external addresses only).
 *   message   — the relay refused this message's content (DATA 5xx): fail it,
 *               no retry, but the address is fine.
 *   transport — anything about us or the relay (auth, connection, timeouts,
 *               4xx, relay denied 5.7.x): retry later and stop the batch —
 *               never suppress, or a wrong password would blacklist everyone.
 */
export type SmtpFailure = 'recipient' | 'message' | 'transport';

export interface SmtpResult {
  ok: boolean;
  messageId?: string;
  failure?: SmtpFailure;
  /** Kept for callers that only need yes/no: a recipient-level rejection. */
  permanent?: boolean;
  error?: string;
}

export function classifySmtpError(e: {
  code?: string; command?: string; responseCode?: number; response?: string;
}): SmtpFailure {
  const status = e.responseCode ?? 0;
  const response = e.response ?? '';
  if (status >= 500 && status < 600) {
    // 5.7.x is policy: relay denied, authentication required, sender rejected —
    // a configuration problem on our side, not a bad address.
    if (/\b5\.7\.\d+/.test(response) || status === 530 || status === 535) return 'transport';
    if (e.command === 'RCPT TO' || e.code === 'EENVELOPE') return 'recipient';
    if (e.command === 'DATA' || e.code === 'EMESSAGE') return 'message';
  }
  return 'transport';
}

/**
 * Send one message. Classifies the failure so the caller knows whether to
 * retry (transient) or suppress the address (permanent) — FR-MAIL-7's
 * bounce handling starts here, at the synchronous rejection, and is completed
 * by any webhook the relay calls back.
 */
export async function sendSmtp(cfg: SmtpConfig, mail: OutboundMail): Promise<SmtpResult> {
  try {
    const info = await getTransport(cfg).sendMail({
      // Objects, not hand-built strings: MAIL_FROM is often "Name <addr>" in
      // production, and wrapping that in another "<…>" sent every message with
      // a stray ">" in the sender's name.
      from: { name: sanitizeName(mail.fromName), address: bareAddress(cfg.from) },
      to: mail.toName ? { name: sanitizeName(mail.toName), address: bareAddress(mail.to) } : mail.to,
      replyTo: mail.replyTo,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      attachments: mail.attachments,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    const e = err as { code?: string; command?: string; responseCode?: number; response?: string; message?: string };
    const failure = classifySmtpError(e);
    return {
      ok: false,
      failure,
      permanent: failure === 'recipient',
      error: (e.message ?? 'SMTP send failed').slice(0, 500),
    };
  }
}

/** Verify the relay is reachable and credentials work — used by health checks. */
export async function verifySmtp(cfg: SmtpConfig): Promise<boolean> {
  try {
    await getTransport(cfg).verify();
    return true;
  } catch {
    return false;
  }
}

function sanitizeName(name: string): string {
  return name.replace(/["\r\n]/g, '').slice(0, 120);
}

/** "NGA Tupo <mis@nga.ac.rw>" or "mis@nga.ac.rw" → "mis@nga.ac.rw". */
export function bareAddress(value: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  return (angle ? angle[1]! : value).trim();
}
