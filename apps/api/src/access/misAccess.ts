import { config } from '../config.js';
import type { AccessSnapshot, Depth, Manifest, Target } from '../vendor/nga-access/index.js';

/**
 * The MIS access-control v2 endpoints Tupo talks to. Every call has a short
 * timeout: an access check must never hang a request behind a slow MIS.
 *
 *   GET  /access/me?app=tupo            user bearer token  -> AccessSnapshot
 *   PUT  /access/manifests/tupo         client credentials -> publish manifest
 *   GET  /access/holders?app=tupo&cap=  client credentials -> approver pools
 *   POST /access/audit                  client credentials -> central audit log
 */

export const ACCESS_APP = 'tupo';
const TIMEOUT_MS = Number(process.env.ACCESS_MIS_TIMEOUT_MS ?? 2500);

const basicAuth = () =>
  `Basic ${Buffer.from(`${config.ssoClientId}:${config.ssoClientSecret}`).toString('base64')}`;

async function timedFetch(url: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export type SnapshotFetch =
  | { ok: true; snapshot: AccessSnapshot }
  /** `unavailable`: MIS down, slow, 5xx/503 (v2 not installed) — keep last-good.
   *  `rejected`: MIS answered 401/403 for this token — no snapshot for it. */
  | { ok: false; reason: 'unavailable' | 'rejected'; status?: number };

/** The user's compiled snapshot for Tupo. Never throws. */
export async function fetchAccessSnapshot(misToken: string): Promise<SnapshotFetch> {
  try {
    const res = await timedFetch(`${config.misBaseUrl}/access/me?app=${ACCESS_APP}`, {
      headers: { Authorization: `Bearer ${misToken}` },
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'rejected', status: res.status };
    if (!res.ok) return { ok: false, reason: 'unavailable', status: res.status };
    const body = (await res.json()) as { success?: boolean; data?: AccessSnapshot };
    const snap = body?.data;
    if (!body?.success || !snap || typeof snap.v !== 'number' || typeof snap.caps !== 'object') {
      return { ok: false, reason: 'unavailable', status: res.status };
    }
    return { ok: true, snapshot: snap };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export interface Holder { user_id: number; depth: Depth | null; via: number[] }

/** Who holds `cap` over `target` (MIS user ids). null = MIS could not say. */
export async function fetchHolders(
  cap: string, target: Target = {}, minDepth?: Depth | null,
): Promise<Holder[] | null> {
  try {
    const url = new URL(`${config.misBaseUrl}/access/holders`);
    url.searchParams.set('app', ACCESS_APP);
    url.searchParams.set('cap', cap);
    for (const [k, v] of Object.entries(target)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    if (minDepth) url.searchParams.set('minDepth', minDepth);
    const res = await timedFetch(url.toString(), { headers: { Authorization: basicAuth() } });
    if (!res.ok) return null;
    const body = (await res.json()) as { success?: boolean; data?: Holder[] };
    return Array.isArray(body?.data) ? body.data : null;
  } catch {
    return null;
  }
}

export interface CentralAuditEntry {
  action: string;
  actor_id: number | null;
  subject_user_id?: number | null;
  target?: Record<string, unknown>;
  reason?: string | null;
}

/** Report a restricted read/redaction to the MIS audit log. Never throws. */
export async function postCentralAudit(entry: CentralAuditEntry): Promise<boolean> {
  try {
    const res = await timedFetch(`${config.misBaseUrl}/access/audit`, {
      method: 'POST',
      headers: { Authorization: basicAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** PUT the manifest (deploy step). Returns status + parsed body; throws on network error. */
export async function publishManifest(manifest: Manifest): Promise<{ status: number; body: unknown }> {
  const res = await timedFetch(`${config.misBaseUrl}/access/manifests/${ACCESS_APP}`, {
    method: 'PUT',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  }, 15_000);
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  return { status: res.status, body };
}

/** MIS user ids are numeric; Tupo stores them as text. */
export const misIdNumber = (misUserId: string | null | undefined): number | null => {
  const n = Number(misUserId);
  return Number.isInteger(n) && n > 0 ? n : null;
};
