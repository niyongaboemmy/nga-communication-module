/**
 * Meeting reminders — the backstop sweep (MIS Reminder Hub).
 *
 *   reminders:sync — every 30 minutes, and once shortly after boot
 *
 * The API tells the Hub about each meeting the moment it is scheduled, edited
 * or cancelled, but it does so fire-and-forget: a MIS that was down, a deploy
 * that restarted the API mid-call, or a conversation that gained a member all
 * leave the Hub's copy stale. This re-sends every scheduled meeting in the next
 * 14 days (idempotent on the Hub's side) and withdraws recently cancelled ones.
 *
 * The work lives in `@tupo/notify`, shared with the API, so a meeting is
 * described to the Hub identically whichever path sends it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { reminders } from '@tupo/notify';

/**
 * The Hub authenticates Tupo with its SSO client credentials, and in
 * production those live only in apps/api/.env (see the deploy workflow). Rather
 * than copy a secret into a second file, borrow exactly these keys from the
 * API's .env when the worker's own environment lacks them. Nothing else is
 * read from it, so the worker's PORT, Redis and database settings are never
 * shadowed.
 */
const BORROWED_KEYS = ['NGA_MIS_BASE_URL', 'SSO_CLIENT_ID', 'SSO_CLIENT_SECRET', 'APP_PUBLIC_URL', 'CORS_ORIGINS'];

export function borrowApiCredentials(
  env: NodeJS.ProcessEnv = process.env,
  apiEnvPath = env.REMINDERS_API_ENV_PATH ?? resolve(process.cwd(), '../api/.env'),
): string[] {
  let parsed: Record<string, string>;
  try { parsed = parse(readFileSync(apiEnvPath)); } catch { return []; }
  const borrowed: string[] = [];
  for (const key of BORROWED_KEYS) {
    if (env[key] === undefined && parsed[key] !== undefined) {
      env[key] = parsed[key];
      borrowed.push(key);
    }
  }
  return borrowed;
}

export async function runReminderSync(): Promise<unknown> {
  const result = await reminders.runReminderSweep();
  if (result.errors.length) {
    console.warn(`[worker] reminders:sync — ${result.errors.length} error(s):`, result.errors.slice(0, 5).join(' | '));
  }
  return result;
}
