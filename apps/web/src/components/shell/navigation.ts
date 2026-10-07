import {
  MessagesSquare, Megaphone, Video, Mail, Activity,
  ShieldCheck, Users, ScrollText, Eye, LayoutDashboard,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavEntry {
  to: string;
  icon: LucideIcon;
  label: string;
  /** Permission(s) that reveal the entry. Any one is enough. */
  perm: string | string[];
}

/**
 * The product modules (SRS §15.1). Files is left out until it exists (its
 * route is only a Coming Soon page). Order is deliberate: it is the order of
 * the rail on desktop, the bottom tab bar on mobile, and the ⌘K module results,
 * so a user's muscle memory carries between form factors.
 *
 * Every entry declares the permission that reveals it. This is UX only — each
 * route's data is independently authorised server-side, so hiding an icon is
 * never what keeps a user out.
 */
export const MODULES: NavEntry[] = [
  { to: '/app/chat', icon: MessagesSquare, label: 'Chat', perm: 'MESSAGE_READ' },
  { to: '/app/feed', icon: Megaphone, label: 'Feed', perm: 'FEED_VIEW' },
  { to: '/app/meet', icon: Video, label: 'Meet', perm: 'MEET_JOIN' },
  { to: '/app/mail', icon: Mail, label: 'Mail', perm: 'MAIL_READ' },
];

export const ADMIN: NavEntry[] = [
  { to: '/app/admin/dashboard', icon: LayoutDashboard, label: 'Dashboard', perm: 'DASHBOARD_VIEW' },
  { to: '/app/admin/users', icon: Users, label: 'Users', perm: ['USERS_VIEW', 'USERS_MANAGE'] },
  {
    to: '/app/admin/roles', icon: ShieldCheck, label: 'Roles & permissions',
    perm: ['ROLES_PERMISSIONS_VIEW', 'ROLES_PERMISSIONS_MANAGE'],
  },
  {
    to: '/app/admin/oversight', icon: Eye, label: 'Oversight',
    perm: ['OVERSIGHT_VIEW_ALL', 'OVERSIGHT_MESSAGE_DELETE'],
  },
  { to: '/app/admin/audit', icon: ScrollText, label: 'Audit log', perm: 'AUDIT_VIEW' },
  { to: '/app/system', icon: Activity, label: 'System status', perm: 'SYSTEM_HEALTH_VIEW' },
];
