/**
 * Instance-level mail policy, read from the environment.
 *
 * Both tupo-api (which decides, at compose time, whether to create an `smtp`
 * delivery row for an internal recipient) and tupo-worker (which sends it) read
 * the same variable, so they cannot disagree.
 */

/**
 * Whether mail addressed to someone who has a Tupo account is ALSO delivered
 * as a real email to their address, on top of the in-app copy.
 *
 * FR-MAIL-9's default is in-app only (no SMTP bill). Set `MAIL_INTERNAL_EMAIL=on`
 * to have internal mail land in Gmail / Outlook the normal way as well. A
 * relay must be configured (`SMTP_HOST` in the worker) for this to actually
 * send; without one the extra rows are recorded as failed.
 *
 * Individual users can still opt out in mail settings (`mail_prefs.email_copies`).
 */
export function internalEmailDelivery(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.MAIL_INTERNAL_EMAIL ?? '').trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1' || v === 'yes';
}
