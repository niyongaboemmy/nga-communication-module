import { CapabilityDef, defineManifest, Depth, Domain } from '../vendor/nga-access/index.js';

/**
 * Tupo capability manifest (access control v2 -- see
 * nga_central_mis/ACCESS_LEVELS_RBAC_IMPLEMENTATION_PLAN.md and
 * nga_central_mis/packages/access/README.md).
 *
 * Keys are the existing permission keys (packages/shared/src/permissions.ts),
 * so no call site is renamed. Communication capabilities are mostly personal
 * (granted at SELF); DASHBOARD_VIEW carries a depth (`summary` = aggregates,
 * `detail` = per-person rows) and OVERSIGHT_* are restricted: they can only be
 * granted with a justification and an end date, and every use is audited.
 *
 * Published to MIS on deploy (npm run access:publish).
 */

const R = (label: string, domain: Domain, depths: Depth[] = ['detail'], extra: Partial<CapabilityDef> = {}): CapabilityDef =>
  ({ label, domain, kind: 'READ', depths, ...extra });
const W = (label: string, domain: Domain, extra: Partial<CapabilityDef> = {}): CapabilityDef =>
  ({ label, domain, kind: 'WRITE', ...extra });
const SCHOOL_ONLY = { scopeable: false };

export const TUPO_MANIFEST = defineManifest({
  app: 'tupo',
  name: 'Tupo',
  version: '2026.09.27',
  capabilities: {
    MESSAGE_SEND: W('Send messages', 'COMMS'),
    MESSAGE_READ: R('Read messages', 'COMMS'),
    MESSAGE_EDIT_OWN: W('Edit own messages', 'COMMS'),
    MESSAGE_DELETE_OWN: W('Delete own messages', 'COMMS'),
    MESSAGE_DELETE_ANY: W("Delete anyone's messages", 'COMMS', SCHOOL_ONLY),
    MESSAGE_PIN: W('Pin messages', 'COMMS'),
    MESSAGE_FORWARD: W('Forward messages', 'COMMS'),
    MESSAGE_SCHEDULE: W('Schedule messages', 'COMMS'),
    DM_START: W('Start direct messages', 'COMMS'),

    CHANNEL_VIEW: R('View channels', 'COMMS'),
    CHANNEL_JOIN: W('Join channels', 'COMMS'),
    CHANNEL_CREATE: W('Create channels', 'COMMS'),
    CHANNEL_MANAGE: W('Manage channels', 'COMMS'),
    CHANNEL_MEMBERS_MANAGE: W('Manage channel members', 'COMMS'),
    CHANNEL_ARCHIVE: W('Archive channels', 'COMMS', SCHOOL_ONLY),
    CHANNEL_ANNOUNCE: W('Post announcements', 'COMMS'),

    MEET_JOIN: W('Join meetings', 'COMMS'),
    MEET_START: W('Start meetings', 'COMMS'),
    MEET_SCHEDULE: W('Schedule meetings', 'COMMS'),
    MEET_HOST_CONTROLS: W('Meeting host controls', 'COMMS'),
    MEET_RECORD: W('Record meetings', 'COMMS'),
    MEET_SCREENSHARE: W('Share screen', 'COMMS'),
    MEET_ATTENDANCE_VIEW: R('View meeting attendance', 'COMMS', ['summary', 'detail']),
    MEET_TRANSCRIBE: W('Transcribe meetings', 'COMMS'),
    MEET_AI_USE: W('Use the AI notetaker', 'COMMS'),

    FILE_UPLOAD: W('Upload files', 'COMMS'),
    FILE_DOWNLOAD: R('Download files', 'COMMS'),
    FILE_DELETE_OWN: W('Delete own files', 'COMMS'),
    FILE_DELETE_ANY: W("Delete anyone's files", 'COMMS', SCHOOL_ONLY),
    FILE_QUOTA_MANAGE: W('Manage file quotas', 'SYSTEM', SCHOOL_ONLY),

    FEED_VIEW: R('View the feed', 'COMMS'),
    FEED_COMMENT: W('Comment and react', 'COMMS'),
    FEED_POST: W('Post on pages', 'COMMS'),
    FEED_PAGE_MANAGE: W('Create and manage pages', 'COMMS'),
    FEED_ANALYTICS_VIEW: R('View feed analytics', 'COMMS', ['summary', 'detail']),
    FEED_STORY_POST: W('Post stories', 'COMMS'),
    FEED_REEL_POST: W('Post reels', 'COMMS'),

    MAIL_READ: R('Read mail', 'COMMS'),
    MAIL_SEND: W('Send mail', 'COMMS'),
    MAIL_BULK_SEND: W('Send bulk mail', 'COMMS'),
    MAIL_TEMPLATE_MANAGE: W('Manage mail templates', 'COMMS'),
    MAIL_LIST_MANAGE: W('Manage distribution lists', 'COMMS'),
    MAIL_APPROVE: W('Approve bulk mail', 'COMMS'),
    MAIL_AI_USE: W('Use the mail AI assistant', 'COMMS'),

    DIRECTORY_VIEW: R('View the directory', 'PEOPLE'),
    PRESENCE_VIEW: R('See who is online', 'PEOPLE'),
    DIRECTORY_SYNC: W('Sync the directory from MIS', 'SYSTEM', SCHOOL_ONLY),

    REPORT_SUBMIT: W('Report content', 'WELFARE'),
    MODERATION_QUEUE_VIEW: R('View the moderation queue', 'WELFARE', ['detail'], SCHOOL_ONLY),
    MODERATION_ACT: W('Moderate (warn, mute, suspend)', 'WELFARE', SCHOOL_ONLY),
    CONTACT_POLICY_MANAGE: W('Manage who may contact whom', 'WELFARE', SCHOOL_ONLY),
    OVERSIGHT_VIEW_ALL: R('Read any conversation (oversight)', 'WELFARE', ['sensitive'], { restricted: true, scopeable: false }),
    OVERSIGHT_MESSAGE_DELETE: W('Redact messages (oversight)', 'WELFARE', { restricted: true, scopeable: false }),

    USERS_VIEW: R('View users', 'PEOPLE', ['detail'], SCHOOL_ONLY),
    USERS_MANAGE: W('Manage users and local roles', 'PEOPLE', SCHOOL_ONLY),
    SPACE_MANAGE: W('Manage spaces', 'SYSTEM', SCHOOL_ONLY),
    RETENTION_MANAGE: W('Manage retention', 'SYSTEM', SCHOOL_ONLY),
    AUDIT_VIEW: R('View the audit log', 'SYSTEM', ['detail'], SCHOOL_ONLY),
    ANALYTICS_VIEW: R('View analytics', 'REPORTING', ['summary']),
    DASHBOARD_VIEW: R('Activity dashboard', 'REPORTING', ['summary', 'detail']),
    SYSTEM_HEALTH_VIEW: R('View system health', 'SYSTEM', ['summary'], SCHOOL_ONLY),
    INTEGRATIONS_MANAGE: W('Manage integrations', 'SYSTEM', SCHOOL_ONLY),
    COMPLIANCE_EXPORT: W('Compliance export', 'SYSTEM', SCHOOL_ONLY),
    ROLES_PERMISSIONS_VIEW: R('View roles & permissions', 'ACCESS', ['detail'], SCHOOL_ONLY),
    ROLES_PERMISSIONS_MANAGE: W('Manage roles & permissions', 'ACCESS', SCHOOL_ONLY),
    NOTIFICATIONS_MANAGE: W('Manage own notifications', 'SYSTEM'),
    SETTINGS_MANAGE: W('Manage own settings', 'SYSTEM'),
  },
  insights: {
    'engagement.active_rate': { label: 'Active users', capability: 'DASHBOARD_VIEW', minDepth: 'summary', levels: ['SCHOOL', 'PROGRAM', 'GRADE', 'CLASS_GROUP'] },
    'comms.parent_mail_response_time': { label: 'Parent mail response time', capability: 'DASHBOARD_VIEW', minDepth: 'summary', levels: ['SCHOOL', 'PROGRAM'] },
  },
});

export default TUPO_MANIFEST;
