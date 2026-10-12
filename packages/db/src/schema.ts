import {
  pgTable, text, timestamp, boolean, integer, bigint, real, jsonb, index, uniqueIndex, primaryKey,
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
  /** The wide profile cover from NGA MIS (null = none). */
  coverUrl: text('cover_url'),
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

/* ================================================================== *
 * Meet (SRS §6.5, §10) — see migrations/0004_meet.sql for the DDL,
 * including the partitioning of meeting_events, which Drizzle does not
 * model. These definitions describe shape only.
 * ================================================================== */

export const meetings = pgTable('meetings', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  spaceId: text('space_id').references(() => spaces.id, { onDelete: 'set null' }),
  hostId: text('host_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default('Meeting'),
  description: text('description'),
  /** Media-server room handle — unguessable, and never shown to a user. */
  roomName: text('room_name').notNull(),
  /** The human-facing `abc-defg-hij`. Rotatable without moving the room. */
  joinCode: text('join_code').notNull(),
  status: text('status').notNull().default('scheduled'),
  mediaMode: text('media_mode').notNull().default('auto'),
  /** What the server actually chose, set on first join. */
  transport: text('transport'),
  scheduledStart: timestamp('scheduled_start', { withTimezone: true }),
  scheduledEnd: timestamp('scheduled_end', { withTimezone: true }),
  recurrenceRule: text('recurrence_rule'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  settings: jsonb('settings').notNull().default({}),
  peakParticipants: integer('peak_participants').notNull().default(0),
  totalParticipants: integer('total_participants').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  roomNameIdx: uniqueIndex('meetings_room_name_key').on(t.roomName),
  joinCodeIdx: uniqueIndex('meetings_join_code_key').on(t.joinCode),
  hostIdx: index('meetings_host_idx').on(t.hostId),
  statusIdx: index('meetings_status_idx').on(t.status),
}));

/** The attendance record (FR-MEET-15). Written on every state change. */
export const meetingParticipants = pgTable('meeting_participants', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  /** NULL for a guest — guests never get a users row. */
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  displayName: text('display_name').notNull(),
  isGuest: boolean('is_guest').notNull().default(false),
  role: text('role').notNull().default('attendee'),
  state: text('state').notNull().default('lobby'),
  connectionQuality: text('connection_quality').notNull().default('good'),
  audioEnabled: boolean('audio_enabled').notNull().default(false),
  videoEnabled: boolean('video_enabled').notNull().default(false),
  screenSharing: boolean('screen_sharing').notNull().default(false),
  handRaisedAt: timestamp('hand_raised_at', { withTimezone: true }),
  deviceLabel: text('device_label'),
  ipAddress: text('ip_address'),
  /** Binds a guest's session token to exactly one participant row. NULL for
   *  everyone who arrived with a real account. */
  guestTokenId: text('guest_token_id'),
  /** Cloudflare Realtime: the SFU session publishing this participant's tracks.
   *  Everyone needs it to subscribe, so it is on the roster too. */
  sfuSessionId: text('sfu_session_id'),
  knockedAt: timestamp('knocked_at', { withTimezone: true }),
  admittedAt: timestamp('admitted_at', { withTimezone: true }),
  admittedBy: text('admitted_by').references(() => users.id, { onDelete: 'set null' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }),
  leftAt: timestamp('left_at', { withTimezone: true }),
  /** Accumulated across reconnects, not just the last leg. */
  durationSeconds: integer('duration_seconds').notNull().default(0),
  speakingSeconds: integer('speaking_seconds').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  meetingIdx: index('meeting_participants_meeting_idx').on(t.meetingId),
  userIdx: index('meeting_participants_user_idx').on(t.userId),
}));

/** Partitioned by month in SQL — the proctoring event model, verbatim. */
export const meetingEvents = pgTable('meeting_events', {
  id: text('id').notNull(),
  meetingId: text('meeting_id').notNull(),
  participantId: text('participant_id'),
  actorId: text('actor_id'),
  type: text('type').notNull(),
  severity: text('severity').notNull().default('info'),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const meetingChatMessages = pgTable('meeting_chat_messages', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  participantId: text('participant_id').notNull().references(() => meetingParticipants.id, { onDelete: 'cascade' }),
  senderName: text('sender_name').notNull(),
  body: text('body').notNull(),
  /** Set for a private in-meeting DM. Excluded from the AI transcript and the minutes. */
  toParticipantId: text('to_participant_id').references(() => meetingParticipants.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ meetingIdx: index('meeting_chat_meeting_idx').on(t.meetingId, t.createdAt) }));

/**
 * The transcript. Speaker attribution is structural, not inferred: a segment
 * arrives on the socket of the person whose microphone produced it, so there is
 * no diarization step that can get it wrong.
 */
export const meetingTranscriptSegments = pgTable('meeting_transcript_segments', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  participantId: text('participant_id').references(() => meetingParticipants.id, { onDelete: 'set null' }),
  speakerName: text('speaker_name').notNull(),
  text: text('text').notNull(),
  lang: text('lang').notNull().default('en-US'),
  isFinal: boolean('is_final').notNull().default(true),
  confidence: real('confidence'),
  /** Offset from meeting start — chapters and recording seeks line up on this. */
  offsetSeconds: integer('offset_seconds'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ meetingIdx: index('meeting_transcript_meeting_idx').on(t.meetingId, t.startedAt) }));

export const meetingAiArtifacts = pgTable('meeting_ai_artifacts', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  content: jsonb('content').notNull(),
  /** Which of the four providers answered. Recorded because it is the first
   *  thing anyone asks of a generated summary. */
  providerUsed: text('provider_used'),
  segmentCount: integer('segment_count').notNull().default(0),
  requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ meetingIdx: index('meeting_ai_meeting_idx').on(t.meetingId, t.kind) }));

export const meetingPolls = pgTable('meeting_polls', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull().references(() => meetingParticipants.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('poll'),
  question: text('question').notNull(),
  options: jsonb('options').notNull(),
  correctOptionIndex: integer('correct_option_index'),
  anonymous: boolean('anonymous').notNull().default(false),
  multipleChoice: boolean('multiple_choice').notNull().default(false),
  status: text('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => ({ meetingIdx: index('meeting_polls_meeting_idx').on(t.meetingId, t.createdAt) }));

/** One vote per participant per poll — changing your mind updates, never adds. */
export const meetingPollVotes = pgTable('meeting_poll_votes', {
  pollId: text('poll_id').notNull().references(() => meetingPolls.id, { onDelete: 'cascade' }),
  participantId: text('participant_id').notNull().references(() => meetingParticipants.id, { onDelete: 'cascade' }),
  optionIndexes: jsonb('option_indexes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.pollId, t.participantId] }) }));

export const meetingQuestions = pgTable('meeting_questions', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  participantId: text('participant_id').notNull().references(() => meetingParticipants.id, { onDelete: 'cascade' }),
  askedBy: text('asked_by').notNull(),
  text: text('text').notNull(),
  upvotes: integer('upvotes').notNull().default(0),
  answered: boolean('answered').notNull().default(false),
  answerText: text('answer_text'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ meetingIdx: index('meeting_questions_meeting_idx').on(t.meetingId, t.upvotes) }));

export const meetingQuestionUpvotes = pgTable('meeting_question_upvotes', {
  questionId: text('question_id').notNull().references(() => meetingQuestions.id, { onDelete: 'cascade' }),
  participantId: text('participant_id').notNull().references(() => meetingParticipants.id, { onDelete: 'cascade' }),
}, (t) => ({ pk: primaryKey({ columns: [t.questionId, t.participantId] }) }));

export const meetingBreakouts = pgTable('meeting_breakouts', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  roomName: text('room_name').notNull(),
  status: text('status').notNull().default('open'),
  closesAt: timestamp('closes_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => ({ meetingIdx: index('meeting_breakouts_meeting_idx').on(t.meetingId) }));

export const meetingBreakoutMembers = pgTable('meeting_breakout_members', {
  breakoutId: text('breakout_id').notNull().references(() => meetingBreakouts.id, { onDelete: 'cascade' }),
  participantId: text('participant_id').notNull().references(() => meetingParticipants.id, { onDelete: 'cascade' }),
}, (t) => ({ pk: primaryKey({ columns: [t.breakoutId, t.participantId] }) }));

export const meetingRecordings = pgTable('meeting_recordings', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  fileId: text('file_id').references(() => files.id, { onDelete: 'set null' }),
  startedBy: text('started_by').references(() => users.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('recording'),
  /** The media server's own job handle, so a stop request can find it. */
  egressId: text('egress_id'),
  /** server | client — see RECORDING_MODES. The two have different guarantees,
   *  so anyone reading a recording back needs to know which they have. */
  mode: text('mode').notNull().default('server'),
  durationSeconds: integer('duration_seconds'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  /** Prefix in the file store — every recording for a meeting sits together. */
  folder: text('folder'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (t) => ({ meetingIdx: index('meeting_recordings_meeting_idx').on(t.meetingId) }));

export const meetingInvites = pgTable('meeting_invites', {
  meetingId: text('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  response: text('response').notNull().default('pending'),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.meetingId, t.userId] }) }));


/**
 * A person's own notes.
 *
 * Deliberately not `meeting_ai_artifacts`: an artifact is regenerated on
 * demand, a note is not. Someone's own record of a meeting must never be
 * overwritten by the next summary run, which is exactly what would happen if
 * they shared a table.
 */
export const meetingNotes = pgTable('meeting_notes', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull().references(() => meetings.id, { onDelete: 'cascade' }),
  /** The author of record — the only identity a guest has. */
  participantId: text('participant_id').notNull()
    .references(() => meetingParticipants.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  authorName: text('author_name').notNull(),
  body: text('body').notNull(),
  /** manual | capture | ai | tidied */
  source: text('source').notNull().default('manual'),
  /** What it said before the AI touched it — what makes "tidy this up" safe. */
  originalBody: text('original_body'),
  providerUsed: text('provider_used'),
  offsetSeconds: integer('offset_seconds'),
  isShared: boolean('is_shared').notNull().default(false),
  pinned: boolean('pinned').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  meetingIdx: index('meeting_notes_meeting_idx').on(t.meetingId, t.createdAt),
}));

/** Single sign-out: sessions of this user issued before revoked_at are over (0029). */
export const sessionRevocations = pgTable('session_revocations', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull(),
});
