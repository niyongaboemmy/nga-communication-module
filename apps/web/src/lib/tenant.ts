/**
 * The school (tenant) of the signed-in session, for naming on-device storage
 * (multi-tenancy contract §8: browser storage keys include the tid). The
 * session JWT carries `tid` since tenancy; an older one is tenant 1.
 */
const SESSION_KEY = 'tupo_token';

export function tidOfToken(token: string | null | undefined): number {
  if (!token) return 1;
  try {
    const part = token.split('.')[1] ?? '';
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { tid?: unknown };
    const n = Number(json.tid);
    return Number.isSafeInteger(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

export function currentSessionTid(): number {
  try { return tidOfToken(localStorage.getItem(SESSION_KEY)); } catch { return 1; }
}

/** `<tid>-<userId>`: the owner key of this account's on-device data. */
export function storageOwner(userId: string | null | undefined, tid = currentSessionTid()): string | null {
  return userId ? `${tid}-${userId}` : null;
}
