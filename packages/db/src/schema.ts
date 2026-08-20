import {
  pgTable, text, timestamp, boolean, integer, bigint, jsonb, index, uniqueIndex, primaryKey,
} from 'drizzle-orm/pg-core';

/**
 * Identity mirrored from the NGA Central MIS.
 *
 * NOTE FOR REVIEWERS: there is deliberately no password, password_hash, salt,
 * otp_secret or any other credential column here, and there never should be.
 * Tupo has no login of its own — every user arrives already authenticated by
 * the MIS (see apps/api/src/routes/sso.ts). A test in apps/api asserts this.
 */
export const users = pgTable('users', {
  id: text('id').primaryKey(),                       // snowflake
  misUserId: text('mis_user_id').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull().default(''),
  avatarUrl: text('avatar_url'),
  /** Effective Tupo role. Admin-assigned values are sticky across logins. */
  role: text('role').notNull().default('unassigned'),
  /** True once an administrator has set the role by hand, so a later MIS
   *  login cannot silently downgrade it back to the derived value. */
  roleAssignedByAdmin: boolean('role_assigned_by_admin').notNull().default(false),
  preferredTheme: text('preferred_theme'),
  status: text('status').notNull().default('active'), // active | suspended
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  misUserIdx: uniqueIndex('users_mis_user_id_idx').on(t.misUserId),
  emailIdx: index('users_email_idx').on(t.email),
}));

/** One row per browser/device holding a session, so sessions can be listed and revoked. */
export const userDevices = pgTable('user_devices', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  label: text('label'),
  userAgent: text('user_agent'),
  ipAddress: text('ip_address'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ userIdx: index('user_devices_user_id_idx').on(t.userId) }));

export const spaces = pgTable('spaces', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  retentionDays: integer('retention_days'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ slugIdx: uniqueIndex('spaces_slug_idx').on(t.slug) }));

export const spaceMembers = pgTable('space_members', {
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.spaceId, t.userId] }) }));

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),                       // dm | group | channel | announcement
  slug: text('slug'),
  name: text('name'),
  topic: text('topic'),
  isPrivate: boolean('is_private').notNull().default(false),
  isArchived: boolean('is_archived').notNull().default(false),
  /** 'manual' or a MIS provenance string like 'mis:class:42' — lets the
   *  directory sync tell apart channels it owns from hand-made ones. */
  origin: text('origin').notNull().default('manual'),
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
  memberCount: integer('member_count').notNull().default(0),
  createdBy: text('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({ spaceIdx: index('conversations_space_idx').on(t.spaceId) }));

export const conversationMembers = pgTable('conversation_members', {
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull().default(0),
  unreadCount: integer('unread_count').notNull().default(0),
  notification: text('notification').notNull().default('all'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  leftAt: timestamp('left_at', { withTimezone: true }),
}, (t) => ({
  pk: primaryKey({ columns: [t.conversationId, t.userId] }),
  userIdx: index('conversation_members_user_idx').on(t.userId),
}));

/** Partitioned by month in SQL (see migrations) — Drizzle just describes the shape. */
export const messages = pgTable('messages', {
  id: text('id').notNull(),
  conversationId: text('conversation_id').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  senderId: text('sender_id').notNull(),
  type: text('type').notNull().default('text'),
  body: text('body'),
  content: jsonb('content'),
  nonce: text('nonce').notNull(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const files = pgTable('files', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  storageDriver: text('storage_driver').notNull(),
  storageKey: text('storage_key').notNull(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  checksum: text('checksum'),
  status: text('status').notNull().default('pending'), // pending|ready|quarantined|failed
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({ ownerIdx: index('files_owner_idx').on(t.ownerId) }));

/** Append-only. Nothing in the app updates or deletes rows here. */
export const auditLog = pgTable('audit_log', {
  id: text('id').primaryKey(),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  metadata: jsonb('metadata').notNull().default({}),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  actorIdx: index('audit_log_actor_idx').on(t.actorId),
  actionIdx: index('audit_log_action_idx').on(t.action),
}));
