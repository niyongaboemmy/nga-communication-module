import type { Response, NextFunction } from 'express';
import { getPool } from '@tupo/db';
import { fail } from '@tupo/shared';
import { decide, type Depth } from '../vendor/nga-access/index.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { accessMode } from './mode.js';
import { misIdNumber, postCentralAudit } from './misAccess.js';

/**
 * Oversight capabilities are `restricted` in the manifest: granted only with a
 * justification and an expiry, and every use is audited (plan §3.2, §11).
 *
 * `requireRestricted` runs AFTER the ordinary authorizePermission gate. In
 * enforce it additionally demands the v2 capability at its restricted depth
 * (OVERSIGHT_VIEW_ALL @ sensitive; OVERSIGHT_MESSAGE_DELETE is a WRITE).
 * In off/shadow it is a no-op.
 */
export function requireRestricted(cap: string, minDepth: Depth | null) {
  return (req: unknown, res: Response, next: NextFunction) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user || user.access?.mode !== 'enforce') return next();
    if (!user.access.snapshot) {
      return res.status(503).json(fail('Access check unavailable. Please try again shortly.'));
    }
    if (decide(user.access.snapshot, cap, {}, minDepth).allowed) return next();
    return res.status(403).json(fail('Forbidden. You do not have permission to perform this action.'));
  };
}

async function misIdOf(userId: string | null | undefined): Promise<number | null> {
  if (!userId) return null;
  try {
    const { rows } = await getPool().query<{ mis_user_id: string }>(
      'SELECT mis_user_id FROM users WHERE id = $1', [userId]);
    return misIdNumber(rows[0]?.mis_user_id);
  } catch {
    return null;
  }
}

/**
 * Forward an oversight read / redaction to the MIS audit log (POST
 * /access/audit), in addition to Tupo's own audit_log row. enforce: awaited
 * (bounded by the MIS client's short timeout); shadow: fire-and-forget; off:
 * nothing. Never throws and never changes the response.
 */
export async function forwardOversightAudit(req: unknown, entry: {
  action: string;
  subjectUserId?: string | null;
  target: Record<string, unknown>;
  reason?: string | null;
}): Promise<void> {
  const mode = accessMode();
  if (mode === 'off') return;
  const user = (req as AuthenticatedRequest).user;
  const send = async () => {
    await postCentralAudit({
      action: `tupo.${entry.action}`,
      actor_id: misIdNumber(user?.misUserId),
      subject_user_id: await misIdOf(entry.subjectUserId),
      target: { app: 'tupo', ...entry.target },
      reason: entry.reason ?? null,
    });
  };
  if (mode === 'enforce') await send().catch(() => {});
  else void send().catch(() => {});
}
