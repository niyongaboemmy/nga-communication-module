import { SESSION_KEY, USER_KEY, clearSession } from '../lib/api';
import { initActivity, endActivity, getDeviceId, type CatalogEntry } from '../vendor/nga-activity';
import catalog from './tupo.catalog.json';

/**
 * Platform usage analytics for the Tupo SPA (USAGE_ANALYTICS_IMPLEMENTATION_PLAN.md §5.1).
 *
 * Batches go to Tupo's own API (`/api/activity`, same origin), which stamps them
 * with the MIS user behind the session and relays them to the MIS. Only the
 * session token is sent -- never a guest meeting ticket, which is not an
 * account: a guest is a public visitor.
 *
 * `tupo.catalog.json` is a copy of apps/api/src/activity/catalog.json (the copy
 * the API publishes to the MIS). Re-copy with `npm run activity:catalog`; a
 * test fails when the two differ.
 */

const storedUser = (): { misUserId?: unknown; role?: unknown } | null => {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
};

const misUserId = (): number | null => {
  if (!localStorage.getItem(SESSION_KEY)) return null;
  const id = Number(storedUser()?.misUserId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/**
 * Tupo keeps the role it derived from the MIS user type, not the type itself.
 * 'staff' is every TEACHER/STAFF/ADMIN (apps/api routes/sso.ts), which is all
 * the "staff" precise-location policy asks; an elevated 'admin' could be any
 * type, so it stays unknown.
 */
const misUserType = (): string | null => {
  if (!localStorage.getItem(SESSION_KEY)) return null;
  const role = storedUser()?.role;
  return role === 'staff' ? 'STAFF' : role === 'student' ? 'STUDENT' : role === 'parent' ? 'PARENT' : null;
};

export const startActivity = () =>
  initActivity({
    app: 'tupo',
    endpoint: '/api/activity',
    configUrl: '/api/activity/config',
    authHeader: () => {
      const token = localStorage.getItem(SESSION_KEY);
      return token ? `Bearer ${token}` : null;
    },
    userKey: misUserId,
    userType: misUserType,
    release: import.meta.env.VITE_RELEASE,
    catalog: (catalog as { features: CatalogEntry[] }).features,
    // An administrator signed this device out (MIS Usage & Monitoring → User 360).
    onEndCommand: () => {
      clearSession();
      window.location.href = '/';
    },
  });

export { endActivity, getDeviceId };
