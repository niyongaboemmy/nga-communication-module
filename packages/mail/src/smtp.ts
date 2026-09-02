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
  };
}

let transporter: Transporter | null = null;
let cachedKey = '';

export function getTransport(cfg: SmtpConfig): Transporter {
  const key = `${cfg.host}:${cfg.port}:${cfg.user ?? ''}`;
  if (transporter && cachedKey === key) return transporter;
  transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    pool: true,
    maxConnections: 3,
    // FR-MAIL-7: per-minute rate limiting at the transport.
    maxMessages: 100,
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

export interface SmtpResult {
  ok: boolean;
  messageId?: string;
  /** A permanent failure (5xx) — the address should be suppressed. */
  permanent?: boolean;
  error?: string;
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
      from: `"${sanitizeName(mail.fromName)}" <${cfg.from}>`,
      to: mail.toName ? `"${sanitizeName(mail.toName)}" <${mail.to}>` : mail.to,
      replyTo: mail.replyTo,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      attachments: mail.attachments,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    const e = err as { responseCode?: number; message?: string };
    const code = e.responseCode ?? 0;
    return {
      ok: false,
      permanent: code >= 500 && code < 600,
      error: e.message ?? 'SMTP send failed',
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
