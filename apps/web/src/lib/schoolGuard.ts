/**
 * School guard (TENANT_SWITCHING_PLAN.md §4.2, §4.5, Appendix A.1).
 *
 * The school a person works in is the one of their NGA MIS browser session.
 * MIS publishes it in the readable cookie `nga_school = <tid>.<sid>` on
 * `.amashuri.com`. When it names another school than this Tupo session's, the
 * person switched school elsewhere: Tupo leaves this session WITHOUT the
 * "signed out" hold (reason `switch`), keeps queued chat messages for the old
 * school (they are owned by `<tid>:<userId>` and wait for a return), and the
 * landing page signs in again automatically -- into the MIS session's school.
 *
 * Kept free of React/Vite imports so it runs under `node --test`.
 */

export const SCHOOL_COOKIE = 'nga_school';
const VALUE = /^(\d{1,9})\.([A-Za-z0-9_-]{8,32})$/;

export interface SchoolCookie { tid: number; sid: string }

export function parseSchoolCookie(cookie: string | null | undefined): SchoolCookie | null {
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== SCHOOL_COOKIE) continue;
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { return null; }
    const m = VALUE.exec(v);
    if (!m) return null;
    const tid = Number(m[1]);
    return tid > 0 ? { tid, sid: m[2]! } : null;
  }
  return null;
}

/**
 * Appendix A.1: only a cookie naming another school than a present session is
 * a switch. No cookie (MIS not used in this browser, or signed out there -- the
 * verify-mis poll handles that) or no session: nothing to do.
 */
export function schoolGuardDecision(cookie: SchoolCookie | null, sessionTid: number | null): 'ok' | 'switch' {
  if (!cookie || !sessionTid) return 'ok';
  return cookie.tid === sessionTid ? 'ok' : 'switch';
}

/** An API answer that means "this session is for another school": re-sign-in, not sign-out. */
export function isSchoolChangeAnswer(status: number, code: unknown): boolean {
  if (status === 401) return code === 'TENANT_MISMATCH' || code === 'TENANT_UNKNOWN';
  if (status === 409) return code === 'SCHOOL_CHANGED';
  return false;
}

/** The tid of a Tupo session token (claims read, not trusted; a token without tid is school 1). */
export function tidOfSessionToken(token: string | null | undefined): number | null {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const tid = Number(JSON.parse(json)?.tid);
    return Number.isInteger(tid) && tid > 0 ? tid : 1;
  } catch { return null; }
}

const OVERLAY_ID = 'tupo-school-switch-overlay';

/** "Switching to your other school…" while the page is about to navigate (plain DOM). */
export function showSwitchingOverlay(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (!doc || doc.getElementById(OVERLAY_ID)) return;
  const dark = doc.documentElement.classList.contains('dark');
  const el = doc.createElement('div');
  el.id = OVERLAY_ID;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.style.cssText = `position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:${dark ? 'rgba(3,7,18,.92)' : 'rgba(255,255,255,.94)'}`;
  const card = doc.createElement('div');
  card.style.cssText = `padding:14px 18px;border-radius:16px;border:1px solid ${dark ? '#1e3a8a' : '#bfdbfe'};background:${dark ? '#0b1220' : '#eff6ff'};color:${dark ? '#bfdbfe' : '#1e40af'};font:500 14px system-ui,sans-serif`;
  card.textContent = 'Switching to your other school…';
  el.appendChild(card);
  doc.body.appendChild(el);
}
