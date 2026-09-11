/**
 * Tupo's RBAC catalog.
 *
 * Same shape as nga-discipline-attendance's `constants/permissions.ts` so the
 * three NGA apps stay recognisably one system: a flat list of permission keys,
 * each tagged with a display category, plus seeded system roles that reproduce
 * the behaviour people already expect.
 *
 * This is Tupo's OWN authorization model. It is distinct from the MIS
 * permission strings that arrive with the SSO payload — those are used once, to
 * derive a starting role, and are never consulted again for access decisions.
 */

export type RoleLevel = 'STUDENT' | 'PARENT' | 'STAFF' | 'ADMIN';

export interface PermissionDefinition {
  key: string;
  category: string;
  description: string;
}

export const PERMISSION_CATEGORIES = {
  MESSAGING: 'Messaging',
  CHANNELS: 'Channels & Groups',
  MEET: 'Meetings',
  FILES: 'Files',
  FEED: 'Feed & Posts',
  MAIL: 'Mail',
  DIRECTORY: 'Directory & Presence',
  MODERATION: 'Moderation & Safety',
  ADMINISTRATION: 'Administration',
  ROLES_PERMISSIONS: 'Roles & Permissions',
  NOTIFICATIONS: 'Notifications',
  SETTINGS: 'Account Settings',
} as const;

export type PermissionCategory =
  (typeof PERMISSION_CATEGORIES)[keyof typeof PERMISSION_CATEGORIES];

export const PERMISSIONS: PermissionDefinition[] = [
  // ── Messaging ────────────────────────────────────────────────────────────
  { key: 'MESSAGE_SEND', category: PERMISSION_CATEGORIES.MESSAGING, description: 'Send messages in conversations you belong to.' },
  { key: 'MESSAGE_READ', category: PERMISSION_CATEGORIES.MESSAGING, description: 'Read messages in conversations you belong to.' },
  { key: 'MESSAGE_EDIT_OWN', category: PERMISSION_CATEGORIES.MESSAGING, description: 'Edit your own messages within the allowed window.' },
  { key: 'MESSAGE_DELETE_OWN', category: PERMISSION_CATEGORIES.MESSAGING, description: 'Delete your own messages.' },
  { key: 'MESSAGE_DELETE_ANY', category: PERMISSION_CATEGORIES.MESSAGING, description: "Delete anyone's message. Always audit-logged." },
  { key: 'MESSAGE_PIN', category: PERMISSION_CATEGORIES.MESSAGING, description: 'Pin and unpin messages in a conversation.' },
  { key: 'MESSAGE_FORWARD', category: PERMISSION_CATEGORIES.MESSAGING, description: 'Forward messages to other conversations.' },
  { key: 'MESSAGE_SCHEDULE', category: PERMISSION_CATEGORIES.MESSAGING, description: 'Schedule a message to send later.' },
  { key: 'DM_START', category: PERMISSION_CATEGORIES.MESSAGING, description: 'Start a direct message, subject to the contact policy.' },

  // ── Channels & groups ────────────────────────────────────────────────────
  { key: 'CHANNEL_VIEW', category: PERMISSION_CATEGORIES.CHANNELS, description: 'Browse and open channels you may see.' },
  { key: 'CHANNEL_JOIN', category: PERMISSION_CATEGORIES.CHANNELS, description: 'Join public channels.' },
  { key: 'CHANNEL_CREATE', category: PERMISSION_CATEGORIES.CHANNELS, description: 'Create new channels and group conversations.' },
  { key: 'CHANNEL_MANAGE', category: PERMISSION_CATEGORIES.CHANNELS, description: 'Edit channel name, topic, privacy and settings.' },
  { key: 'CHANNEL_MEMBERS_MANAGE', category: PERMISSION_CATEGORIES.CHANNELS, description: 'Invite and remove channel members.' },
  { key: 'CHANNEL_ARCHIVE', category: PERMISSION_CATEGORIES.CHANNELS, description: 'Archive or restore a channel.' },
  { key: 'CHANNEL_ANNOUNCE', category: PERMISSION_CATEGORIES.CHANNELS, description: 'Post in announcement channels where most members are read-only.' },

  // ── Meetings ─────────────────────────────────────────────────────────────
  { key: 'MEET_JOIN', category: PERMISSION_CATEGORIES.MEET, description: 'Join meetings you are invited to.' },
  { key: 'MEET_START', category: PERMISSION_CATEGORIES.MEET, description: 'Start an instant meeting.' },
  { key: 'MEET_SCHEDULE', category: PERMISSION_CATEGORIES.MEET, description: 'Schedule meetings and invite participants.' },
  { key: 'MEET_HOST_CONTROLS', category: PERMISSION_CATEGORIES.MEET, description: 'Mute, remove, admit and promote participants.' },
  { key: 'MEET_RECORD', category: PERMISSION_CATEGORIES.MEET, description: 'Record a meeting.' },
  { key: 'MEET_SCREENSHARE', category: PERMISSION_CATEGORIES.MEET, description: 'Share your screen during a meeting.' },
  { key: 'MEET_ATTENDANCE_VIEW', category: PERMISSION_CATEGORIES.MEET, description: 'View and export meeting attendance.' },
  { key: 'MEET_TRANSCRIBE', category: PERMISSION_CATEGORIES.MEET, description: 'Turn on live captions and the meeting transcript.' },
  { key: 'MEET_AI_USE', category: PERMISSION_CATEGORIES.MEET, description: 'Invite the AI notetaker and generate summaries, minutes and action items.' },

  // ── Files ────────────────────────────────────────────────────────────────
  { key: 'FILE_UPLOAD', category: PERMISSION_CATEGORIES.FILES, description: 'Upload files and attachments.' },
  { key: 'FILE_DOWNLOAD', category: PERMISSION_CATEGORIES.FILES, description: 'Download files you have access to.' },
  { key: 'FILE_DELETE_OWN', category: PERMISSION_CATEGORIES.FILES, description: 'Delete files you uploaded.' },
  { key: 'FILE_DELETE_ANY', category: PERMISSION_CATEGORIES.FILES, description: "Delete anyone's file. Always audit-logged." },
  { key: 'FILE_QUOTA_MANAGE', category: PERMISSION_CATEGORIES.FILES, description: 'Set storage quotas for users and spaces.' },

  // ── Feed ─────────────────────────────────────────────────────────────────
  { key: 'FEED_VIEW', category: PERMISSION_CATEGORIES.FEED, description: 'View the institutional feed.' },
  { key: 'FEED_COMMENT', category: PERMISSION_CATEGORIES.FEED, description: 'Comment and react on posts.' },
  { key: 'FEED_POST', category: PERMISSION_CATEGORIES.FEED, description: 'Publish posts on behalf of a page you administer.' },
  { key: 'FEED_PAGE_MANAGE', category: PERMISSION_CATEGORIES.FEED, description: 'Create pages and manage their editors.' },
  { key: 'FEED_ANALYTICS_VIEW', category: PERMISSION_CATEGORIES.FEED, description: 'View reach and engagement analytics for pages.' },

  // ── Mail ─────────────────────────────────────────────────────────────────
  { key: 'MAIL_READ', category: PERMISSION_CATEGORIES.MAIL, description: 'Read your mailbox.' },
  { key: 'MAIL_SEND', category: PERMISSION_CATEGORIES.MAIL, description: 'Send mail to individual recipients.' },
  { key: 'MAIL_BULK_SEND', category: PERMISSION_CATEGORIES.MAIL, description: 'Send to distribution lists and bulk announcements.' },
  { key: 'MAIL_TEMPLATE_MANAGE', category: PERMISSION_CATEGORIES.MAIL, description: 'Create and edit reusable mail templates.' },
  { key: 'MAIL_LIST_MANAGE', category: PERMISSION_CATEGORIES.MAIL, description: 'Manage distribution lists.' },
  { key: 'MAIL_APPROVE', category: PERMISSION_CATEGORIES.MAIL, description: 'Approve bulk sends that reach more than 200 recipients.' },
  { key: 'MAIL_AI_USE', category: PERMISSION_CATEGORIES.MAIL, description: 'Use the AI writing assistant for drafting, replying, summarising and planning mail.' },

  // ── Directory ────────────────────────────────────────────────────────────
  { key: 'DIRECTORY_VIEW', category: PERMISSION_CATEGORIES.DIRECTORY, description: 'Search the people directory.' },
  { key: 'PRESENCE_VIEW', category: PERMISSION_CATEGORIES.DIRECTORY, description: 'See who is online.' },
  { key: 'DIRECTORY_SYNC', category: PERMISSION_CATEGORIES.DIRECTORY, description: 'Trigger a directory sync from the NGA Central MIS.' },

  // ── Moderation ───────────────────────────────────────────────────────────
  { key: 'REPORT_SUBMIT', category: PERMISSION_CATEGORIES.MODERATION, description: 'Report a message, post or user.' },
  { key: 'MODERATION_QUEUE_VIEW', category: PERMISSION_CATEGORIES.MODERATION, description: 'View reported content awaiting review.' },
  { key: 'MODERATION_ACT', category: PERMISSION_CATEGORIES.MODERATION, description: 'Remove content, warn, mute or suspend a user.' },
  { key: 'CONTACT_POLICY_MANAGE', category: PERMISSION_CATEGORIES.MODERATION, description: 'Define who may start a conversation with whom.' },
  { key: 'OVERSIGHT_VIEW_ALL', category: PERMISSION_CATEGORIES.MODERATION, description: 'Academic oversight: open and read any group, channel or direct message, whether or not you are a member. Every conversation you open is audit-logged.' },
  { key: 'OVERSIGHT_MESSAGE_DELETE', category: PERMISSION_CATEGORIES.MODERATION, description: 'Academic oversight: remove a message from any conversation when it breaks the rules. Requires a reason and is always audit-logged. Does not grant the ability to post or take part.' },

  // ── Administration ───────────────────────────────────────────────────────
  { key: 'USERS_VIEW', category: PERMISSION_CATEGORIES.ADMINISTRATION, description: 'View the user roster.' },
  { key: 'USERS_MANAGE', category: PERMISSION_CATEGORIES.ADMINISTRATION, description: 'Assign roles, suspend and reactivate users.' },
  { key: 'SPACE_MANAGE', category: PERMISSION_CATEGORIES.ADMINISTRATION, description: 'Create and configure spaces.' },
  { key: 'RETENTION_MANAGE', category: PERMISSION_CATEGORIES.ADMINISTRATION, description: 'Set content retention policies.' },
  { key: 'AUDIT_VIEW', category: PERMISSION_CATEGORIES.ADMINISTRATION, description: 'View the audit log.' },
  { key: 'ANALYTICS_VIEW', category: PERMISSION_CATEGORIES.ADMINISTRATION, description: 'View platform usage analytics.' },
  { key: 'DASHBOARD_VIEW', category: PERMISSION_CATEGORIES.ADMINISTRATION, description: 'Open the realtime monitoring dashboard, scoped to the programmes and grades you lead.' },
  { key: 'SYSTEM_HEALTH_VIEW', category: PERMISSION_CATEGORIES.ADMINISTRATION, description: 'View service health and queue status.' },
  { key: 'INTEGRATIONS_MANAGE', category: PERMISSION_CATEGORIES.ADMINISTRATION, description: 'Manage webhooks, bots and API keys.' },
  { key: 'COMPLIANCE_EXPORT', category: PERMISSION_CATEGORIES.ADMINISTRATION, description: 'Export content for legal or compliance purposes.' },

  // ── Roles & permissions ──────────────────────────────────────────────────
  { key: 'ROLES_PERMISSIONS_VIEW', category: PERMISSION_CATEGORIES.ROLES_PERMISSIONS, description: 'View roles and their permission sets.' },
  { key: 'ROLES_PERMISSIONS_MANAGE', category: PERMISSION_CATEGORIES.ROLES_PERMISSIONS, description: 'Create, edit and delete roles and their permissions.' },

  // ── Notifications & settings ─────────────────────────────────────────────
  { key: 'NOTIFICATIONS_MANAGE', category: PERMISSION_CATEGORIES.NOTIFICATIONS, description: 'View and manage your own notifications and preferences.' },
  { key: 'SETTINGS_MANAGE', category: PERMISSION_CATEGORIES.SETTINGS, description: 'View and update your own account preferences.' },
];

export const PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

/** Ordered category list for the admin UI — matches the declaration order above. */
export const CATEGORY_ORDER: string[] = Array.from(new Set(PERMISSIONS.map((p) => p.category)));

export function groupPermissionsByCategory(): Record<string, PermissionDefinition[]> {
  const grouped: Record<string, PermissionDefinition[]> = {};
  for (const p of PERMISSIONS) (grouped[p.category] ??= []).push(p);
  return grouped;
}

/** The baseline every signed-in user gets, whatever their role. */
const BASELINE = [
  'MESSAGE_READ', 'MESSAGE_SEND', 'MESSAGE_EDIT_OWN', 'MESSAGE_DELETE_OWN', 'MESSAGE_FORWARD',
  'CHANNEL_VIEW',
  'MEET_JOIN',
  'FILE_UPLOAD', 'FILE_DOWNLOAD', 'FILE_DELETE_OWN',
  'FEED_VIEW',
  'MAIL_READ',
  'DIRECTORY_VIEW', 'PRESENCE_VIEW',
  'REPORT_SUBMIT',
  'NOTIFICATIONS_MANAGE', 'SETTINGS_MANAGE',
];

/**
 * Seed permission sets for the system roles.
 *
 * Students deliberately cannot start DMs by default — in a school setting that
 * is a safeguarding decision, not an oversight (SRS FR-USR-6). An administrator
 * can grant `DM_START` to a student role if the institution wants it.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  Student: [...BASELINE, 'CHANNEL_JOIN', 'FEED_COMMENT'],

  Parent: [...BASELINE, 'DM_START', 'FEED_COMMENT'],

  Staff: [
    ...BASELINE,
    'DM_START', 'MESSAGE_PIN', 'MESSAGE_SCHEDULE',
    'CHANNEL_JOIN', 'CHANNEL_CREATE', 'CHANNEL_MANAGE', 'CHANNEL_MEMBERS_MANAGE', 'CHANNEL_ANNOUNCE',
    'MEET_START', 'MEET_SCHEDULE', 'MEET_HOST_CONTROLS', 'MEET_RECORD', 'MEET_SCREENSHARE', 'MEET_ATTENDANCE_VIEW',
    'MEET_TRANSCRIBE', 'MEET_AI_USE',
    'FEED_COMMENT', 'FEED_POST',
    'MAIL_SEND', 'MAIL_TEMPLATE_MANAGE', 'MAIL_AI_USE',
    'DIRECTORY_VIEW',
    // A programme lead / class teacher is a Staff role in Tupo. The dashboard
    // they get is hard-scoped by their MIS placement — a teacher with no
    // assignment resolves to "sees only their own row", so this is safe to
    // hold broadly.
    'DASHBOARD_VIEW',
  ],

  Moderator: [
    ...BASELINE,
    'DM_START', 'MESSAGE_PIN', 'MESSAGE_DELETE_ANY',
    'CHANNEL_JOIN', 'CHANNEL_CREATE', 'CHANNEL_MANAGE', 'CHANNEL_MEMBERS_MANAGE', 'CHANNEL_ARCHIVE', 'CHANNEL_ANNOUNCE',
    'MEET_START', 'MEET_SCHEDULE', 'MEET_HOST_CONTROLS', 'MEET_SCREENSHARE', 'MEET_TRANSCRIBE', 'MEET_AI_USE',
    'FEED_COMMENT', 'FEED_POST',
    'MAIL_SEND', 'MAIL_BULK_SEND', 'MAIL_TEMPLATE_MANAGE', 'MAIL_LIST_MANAGE', 'MAIL_APPROVE', 'MAIL_AI_USE',
    'MODERATION_QUEUE_VIEW', 'MODERATION_ACT',
    'OVERSIGHT_VIEW_ALL', 'OVERSIGHT_MESSAGE_DELETE',
    'FILE_DELETE_ANY',
    'USERS_VIEW', 'AUDIT_VIEW', 'DASHBOARD_VIEW',
  ],

  Admin: PERMISSIONS.map((p) => p.key),
};

export const SYSTEM_ROLES: Array<{
  name: string; level: RoleLevel; description: string;
}> = [
  { name: 'Student', level: 'STUDENT', description: 'Enrolled learner. Reads class channels and the feed; cannot start direct messages by default.' },
  { name: 'Parent', level: 'PARENT', description: 'Parent or guardian. Receives announcements and may contact staff.' },
  { name: 'Staff', level: 'STAFF', description: 'Teaching and administrative staff. Runs channels, meetings and announcements.' },
  { name: 'Moderator', level: 'STAFF', description: 'Staff member with content moderation and safeguarding powers.' },
  { name: 'Admin', level: 'ADMIN', description: 'Full platform administration.' },
];

/** Maps a derived Tupo role name to the seeded system role of the same name. */
export const ROLE_LEVEL_BY_NAME: Record<string, RoleLevel> = Object.fromEntries(
  SYSTEM_ROLES.map((r) => [r.name, r.level])
);
