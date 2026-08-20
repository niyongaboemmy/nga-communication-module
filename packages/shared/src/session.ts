import { z } from 'zod';
import type { Role } from './roles.js';

/**
 * The user object Tupo hands its own frontend. It is a projection of the MIS
 * identity — Tupo never mints an identity of its own, and there is no field
 * here that could stand in for a credential.
 */
export const sessionUserSchema = z.object({
  id: z.string(),
  misUserId: z.string(),
  name: z.string(),
  email: z.string().email().or(z.literal('')),
  role: z.enum(['admin', 'staff', 'student', 'parent', 'unassigned']),
  avatarUrl: z.string().optional(),
  preferredTheme: z.enum(['light', 'dark']).optional(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

/**
 * Claims inside Tupo's own session JWT. `misToken` is the MIS's JWT carried
 * along so this app can act on the user's behalf against MIS APIs — the same
 * nesting TaskMentor and Discipline use. It is why nginx needs enlarged
 * header buffers in front of this app.
 */
export interface SessionClaims extends SessionUser {
  misToken?: string;
}

export const ssoExchangeSchema = z.object({ code: z.string().min(1, 'Authorization code is required') });

export interface SsoExchangeResult {
  token: string;
  user: SessionUser;
  /** MIS-native permission strings, passed through untouched. Informational
   *  only — never used for authorization inside Tupo. */
  permissions: string[];
  /** Tupo's OWN RBAC permission keys for this user's role. This is what
   *  `usePermissions()` gates the UI on. */
  rolePermissions: string[];
  roleName: string | null;
  roleLevel: string | null;
}

export type { Role };
