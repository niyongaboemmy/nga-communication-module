-- Mail (FR-MAIL-1…11).
--
-- Tupo Mail is an *internal* mailbox first and an outbound relay second. A
-- message addressed to someone who has a Tupo account is delivered in-app with
-- no SMTP involved at all (FR-MAIL-9); a message to an outside address, or to
-- an internal user who has asked for email copies, goes over the SMTP relay
-- (FR-MAIL-7). Both paths write the same rows, so delivery tracking
-- (FR-MAIL-8) is uniform.
--
-- Threading (FR-MAIL-2) is by normalised subject plus an explicit parent
-- pointer: a reply always carries the thread id it belongs to, and a fresh
-- compose always opens a new thread. `subject_normalized` (the subject with
-- any run of "Re:" / "Fwd:" prefixes stripped and folded to lower case) is
-- kept so the UI can still group look-alikes that arrived without a parent.
--
-- Idempotent throughout, like every migration here. All ids are TEXT
-- snowflakes; every foreign key to a person is `users(id)`.

/* ──────────────────────────────────────────────────────────────────────────
 * Threads
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS mail_threads (
  id                 TEXT PRIMARY KEY,
  subject            TEXT        NOT NULL DEFAULT '(no subject)',
  subject_normalized TEXT        NOT NULL DEFAULT '',
  -- Denormalised so a mailbox list renders from one table.
  last_message_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sender_id     TEXT        REFERENCES users(id) ON DELETE SET NULL,
  last_sender_name   TEXT,
  last_snippet       TEXT        NOT NULL DEFAULT '',
  message_count      INTEGER     NOT NULL DEFAULT 0,
  has_attachments    BOOLEAN     NOT NULL DEFAULT false,
  created_by         TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_threads_subject_norm_idx
  ON mail_threads (subject_normalized, last_message_at DESC);

/* ──────────────────────────────────────────────────────────────────────────
 * Messages
 *
 * One row per sent (or draft, or scheduled) message. The sender's own copy —
 * "Sent", "Drafts", "Scheduled" — is this row; the recipients' copies are
 * `mail_recipients` rows that point back at it.
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS mail_messages (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT        NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,
  from_user_id   TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_name      TEXT        NOT NULL DEFAULT '',
  from_address   TEXT        NOT NULL DEFAULT '',
  subject        TEXT        NOT NULL DEFAULT '(no subject)',
  body_html      TEXT        NOT NULL DEFAULT '',
  body_text      TEXT        NOT NULL DEFAULT '',
  snippet        TEXT        NOT NULL DEFAULT '',
  -- The message this one replies to / forwards, within the same thread.
  parent_id      TEXT        REFERENCES mail_messages(id) ON DELETE SET NULL,
  kind           TEXT        NOT NULL DEFAULT 'new',   -- new | reply | reply_all | forward
  is_draft       BOOLEAN     NOT NULL DEFAULT false,
  -- Set for messages produced by a bulk campaign (FR-MAIL-5); the sender's
  -- mailbox shows one row, not five hundred.
  campaign_id    TEXT,
  template_id    TEXT,
  scheduled_at   TIMESTAMPTZ,                          -- FR-MAIL-10; NULL = send now
  sent_at        TIMESTAMPTZ,
  has_attachments BOOLEAN    NOT NULL DEFAULT false,
  recipient_summary JSONB    NOT NULL DEFAULT '{}'::jsonb, -- {to:n,cc:n,bcc:n}
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_messages_thread_idx  ON mail_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS mail_messages_sender_idx  ON mail_messages (from_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mail_messages_drafts_idx
  ON mail_messages (from_user_id, updated_at DESC) WHERE is_draft;
CREATE INDEX IF NOT EXISTS mail_messages_scheduled_idx
  ON mail_messages (scheduled_at) WHERE scheduled_at IS NOT NULL AND sent_at IS NULL AND NOT is_draft;
CREATE INDEX IF NOT EXISTS mail_messages_campaign_idx ON mail_messages (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_messages_fts_idx
  ON mail_messages USING gin (to_tsvector('simple', coalesce(subject,'') || ' ' || coalesce(body_text,'')));

/* ──────────────────────────────────────────────────────────────────────────
 * Recipients
 *
 * The recipient's mailbox copy AND the per-recipient delivery record
 * (FR-MAIL-8), in one row. `user_id` is set when the address resolved to a
 * Tupo account; the mailbox columns (`folder`, `is_read`, …) only mean
 * anything in that case.
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS mail_recipients (
  id               TEXT PRIMARY KEY,
  message_id       TEXT        NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  thread_id        TEXT        NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,
  kind             TEXT        NOT NULL DEFAULT 'to',   -- to | cc | bcc
  user_id          TEXT        REFERENCES users(id) ON DELETE CASCADE,
  address          TEXT        NOT NULL,
  name             TEXT        NOT NULL DEFAULT '',
  merge_vars       JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Delivery (FR-MAIL-8). channel: how this copy was (or will be) delivered.
  channel          TEXT        NOT NULL DEFAULT 'in_app',  -- in_app | smtp
  delivery_status  TEXT        NOT NULL DEFAULT 'queued',
       -- queued | sending | sent | delivered | bounced | failed | suppressed
  delivery_error   TEXT,
  queued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  attempts         INTEGER     NOT NULL DEFAULT 0,

  -- Mailbox state (internal recipients only).
  folder           TEXT        NOT NULL DEFAULT 'inbox',  -- inbox | archive | trash | spam
  is_read          BOOLEAN     NOT NULL DEFAULT false,
  read_at          TIMESTAMPTZ,
  is_starred       BOOLEAN     NOT NULL DEFAULT false,
  labels           JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- array of mail_labels.id
  is_hidden        BOOLEAN     NOT NULL DEFAULT false,          -- "delete forever" from trash

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_recipients_message_idx ON mail_recipients (message_id);
CREATE INDEX IF NOT EXISTS mail_recipients_mailbox_idx
  ON mail_recipients (user_id, folder, created_at DESC) WHERE user_id IS NOT NULL AND NOT is_hidden;
CREATE INDEX IF NOT EXISTS mail_recipients_unread_idx
  ON mail_recipients (user_id) WHERE user_id IS NOT NULL AND NOT is_read AND folder = 'inbox' AND NOT is_hidden;
CREATE INDEX IF NOT EXISTS mail_recipients_thread_idx ON mail_recipients (thread_id, user_id);
CREATE INDEX IF NOT EXISTS mail_recipients_delivery_idx ON mail_recipients (delivery_status, queued_at);
CREATE INDEX IF NOT EXISTS mail_recipients_address_idx ON mail_recipients (lower(address));

/* ──────────────────────────────────────────────────────────────────────────
 * Attachments (FR-MAIL-3) — handled by tupo-files, same as chat.
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS mail_attachments (
  id          TEXT PRIMARY KEY,
  message_id  TEXT        NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  file_id     TEXT        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  mime        TEXT        NOT NULL DEFAULT 'application/octet-stream',
  size        BIGINT      NOT NULL DEFAULT 0,
  ordinal     INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_attachments_message_idx ON mail_attachments (message_id);
CREATE INDEX IF NOT EXISTS mail_attachments_file_idx    ON mail_attachments (file_id);

/* ──────────────────────────────────────────────────────────────────────────
 * Delivery events (FR-MAIL-7, FR-MAIL-8) — the per-recipient audit trail.
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS mail_delivery_events (
  id            TEXT PRIMARY KEY,
  recipient_id  TEXT        NOT NULL REFERENCES mail_recipients(id) ON DELETE CASCADE,
  message_id    TEXT        NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  type          TEXT        NOT NULL,
      -- queued | sending | sent | delivered | deferred | bounced | complained | failed | suppressed | opened
  detail        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_delivery_events_recipient_idx ON mail_delivery_events (recipient_id, at);
CREATE INDEX IF NOT EXISTS mail_delivery_events_message_idx   ON mail_delivery_events (message_id, at);

/* ──────────────────────────────────────────────────────────────────────────
 * Labels / folders (FR-MAIL-1). System labels have owner_id NULL.
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS mail_labels (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT        REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  color      TEXT        NOT NULL DEFAULT '#6366f1',
  ordinal    INTEGER     NOT NULL DEFAULT 0,
  is_system  BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_labels_owner_name_idx
  ON mail_labels (coalesce(owner_id, ''), lower(name));

/* ──────────────────────────────────────────────────────────────────────────
 * Distribution lists (FR-MAIL-4)
 *
 * `origin` decides how membership is maintained:
 *   manual        — members are added and removed by hand
 *   mis:role:X    — every active user whose Tupo role is X
 *   mis:space:X   — every member of the space with slug X
 *   mis:all       — every active user
 * A worker sweep re-materialises the mis:* lists so they "stay in sync
 * automatically". The local user mirror is the only institutional data Tupo
 * holds, so class- and program-scoped lists are modelled as spaces.
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS mail_distribution_lists (
  id           TEXT PRIMARY KEY,
  name         TEXT        NOT NULL,
  slug         TEXT        NOT NULL,
  description  TEXT        NOT NULL DEFAULT '',
  origin       TEXT        NOT NULL DEFAULT 'manual',
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  member_count INTEGER     NOT NULL DEFAULT 0,
  synced_at    TIMESTAMPTZ,
  created_by   TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_distribution_lists_slug_idx ON mail_distribution_lists (lower(slug));

CREATE TABLE IF NOT EXISTS mail_list_members (
  list_id    TEXT        NOT NULL REFERENCES mail_distribution_lists(id) ON DELETE CASCADE,
  address    TEXT        NOT NULL,
  user_id    TEXT        REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL DEFAULT '',
  merge_vars JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source     TEXT        NOT NULL DEFAULT 'manual',   -- manual | sync
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, address)
);
CREATE INDEX IF NOT EXISTS mail_list_members_user_idx ON mail_list_members (user_id);

/* ──────────────────────────────────────────────────────────────────────────
 * Templates (FR-MAIL-6)
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS mail_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  category    TEXT        NOT NULL DEFAULT 'general',
  subject     TEXT        NOT NULL DEFAULT '',
  body_html   TEXT        NOT NULL DEFAULT '',
  body_text   TEXT        NOT NULL DEFAULT '',
  -- Merge fields the template expects, e.g. ["name","class","parent_of"].
  variables   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  is_shared   BOOLEAN     NOT NULL DEFAULT true,
  created_by  TEXT        REFERENCES users(id) ON DELETE SET NULL,
  updated_by  TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_templates_category_idx ON mail_templates (category, name);

/* ──────────────────────────────────────────────────────────────────────────
 * Campaigns (FR-MAIL-5, FR-MAIL-10)
 *
 * A bulk send: one template (or ad-hoc body), one or more distribution lists,
 * a preview step, an optional approval gate for large audiences, and
 * per-recipient delivery tracking rolled up into `counts`.
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS mail_campaigns (
  id                TEXT PRIMARY KEY,
  name              TEXT        NOT NULL DEFAULT '',
  subject           TEXT        NOT NULL DEFAULT '',
  body_html         TEXT        NOT NULL DEFAULT '',
  body_text         TEXT        NOT NULL DEFAULT '',
  template_id       TEXT        REFERENCES mail_templates(id) ON DELETE SET NULL,
  from_user_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_name         TEXT        NOT NULL DEFAULT '',
  from_address      TEXT        NOT NULL DEFAULT '',
  status            TEXT        NOT NULL DEFAULT 'draft',
      -- draft | pending_approval | approved | scheduled | sending | sent | failed | cancelled
  list_ids          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  extra_recipients  JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- [{address,name,merge_vars}]
  scheduled_at      TIMESTAMPTZ,
  requires_approval BOOLEAN     NOT NULL DEFAULT false,
  approved_by       TEXT        REFERENCES users(id) ON DELETE SET NULL,
  approved_at       TIMESTAMPTZ,
  rejected_reason   TEXT,
  total_recipients  INTEGER     NOT NULL DEFAULT 0,
  counts            JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- {queued,sent,delivered,bounced,failed}
  created_by        TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS mail_campaigns_status_idx ON mail_campaigns (status, scheduled_at);
CREATE INDEX IF NOT EXISTS mail_campaigns_creator_idx ON mail_campaigns (created_by, created_at DESC);

/* ──────────────────────────────────────────────────────────────────────────
 * Suppression list (FR-MAIL-7) — addresses that bounced hard or complained.
 * The send path skips any address in here and records why.
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS mail_suppressions (
  address    TEXT PRIMARY KEY,          -- stored lower-cased
  reason     TEXT        NOT NULL,       -- bounce | complaint | manual
  note       TEXT        NOT NULL DEFAULT '',
  source_message_id TEXT,
  created_by TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* ──────────────────────────────────────────────────────────────────────────
 * Per-user mail preferences (signature, display name, email-copy opt-in).
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS mail_prefs (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name      TEXT,
  signature_html    TEXT        NOT NULL DEFAULT '',
  signature_enabled BOOLEAN     NOT NULL DEFAULT false,
  -- FR-MAIL-9 is the default: internal mail stays in-app. Opting in here asks
  -- for an SMTP copy of everything addressed to you as well.
  email_copies      BOOLEAN     NOT NULL DEFAULT false,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* ──────────────────────────────────────────────────────────────────────────
 * Seed system labels once. Owner NULL = visible to everyone, not editable.
 * ────────────────────────────────────────────────────────────────────────── */

INSERT INTO mail_labels (id, owner_id, name, color, ordinal, is_system)
VALUES
  ('sys-label-important',  NULL, 'Important',  '#ef4444', 0, true),
  ('sys-label-fees',       NULL, 'Fees',       '#f59e0b', 1, true),
  ('sys-label-academic',   NULL, 'Academic',   '#3b82f6', 2, true),
  ('sys-label-events',     NULL, 'Events',     '#10b981', 3, true),
  ('sys-label-admin',      NULL, 'Admin',      '#8b5cf6', 4, true)
ON CONFLICT DO NOTHING;

/* ──────────────────────────────────────────────────────────────────────────
 * Seed the standard institutional distribution lists (FR-MAIL-4). Their
 * members are materialised by the worker's sync sweep (or a manual sync from
 * the UI); the rows here just make the lists exist on a fresh deployment.
 * ────────────────────────────────────────────────────────────────────────── */

INSERT INTO mail_distribution_lists (id, name, slug, description, origin) VALUES
  ('sys-list-all-staff',    'All Staff',    'all-staff',    'Every member of the Staff space.',  'mis:space:staff'),
  ('sys-list-all-students', 'All Students', 'all-students', 'Every enrolled learner.',           'mis:space:students'),
  ('sys-list-all-parents',  'All Parents',  'all-parents',  'Every parent or guardian.',         'mis:space:parents'),
  ('sys-list-everyone',     'Everyone',     'everyone',     'Every active Tupo account.',        'mis:all')
ON CONFLICT DO NOTHING;

/* ──────────────────────────────────────────────────────────────────────────
 * Seed a few reusable templates (FR-MAIL-6) so the module is not empty.
 * ────────────────────────────────────────────────────────────────────────── */

INSERT INTO mail_templates (id, name, description, category, subject, body_html, body_text, variables, is_shared) VALUES
  ('tpl-fee-notice', 'Term fee notice', 'Reminder that term fees are due.', 'fees',
   'Fee notice for {{name}} — {{term}}',
   '<p>Dear {{first_name}},</p><p>This is a reminder that the fees for <strong>{{term}}</strong> are now due. The outstanding balance for {{name}} is <strong>{{amount}}</strong>, payable by {{due_date}}.</p><p>Please contact the bursary if you have already paid or wish to arrange a payment plan.</p><p>Kind regards,<br>NGA Bursary</p>',
   'Dear {{first_name}}, the fees for {{term}} are now due. Balance for {{name}}: {{amount}}, payable by {{due_date}}.',
   '["name","first_name","term","amount","due_date"]'::jsonb, true),
  ('tpl-term-letter', 'Start-of-term letter', 'Welcome letter with term dates.', 'academic',
   'Welcome to {{term}} at NGA',
   '<p>Dear parents and guardians,</p><p>We are pleased to welcome {{name}} back for {{term}}. Term begins on {{start_date}} and ends on {{end_date}}.</p><p>Please ensure all learners arrive in full uniform with the required materials.</p><p>Warm regards,<br>The NGA Academic Office</p>',
   'We welcome {{name}} back for {{term}}. Term runs {{start_date}} to {{end_date}}.',
   '["name","term","start_date","end_date"]'::jsonb, true),
  ('tpl-event-invite', 'Event invitation', 'Invite parents or staff to a school event.', 'events',
   'You are invited: {{event_name}}',
   '<p>Dear {{first_name}},</p><p>You are warmly invited to <strong>{{event_name}}</strong> on {{event_date}} at {{event_time}}, held at {{venue}}.</p><p>Kindly confirm your attendance by {{rsvp_date}}.</p><p>We look forward to seeing you there.</p>',
   'You are invited to {{event_name}} on {{event_date}} at {{event_time}}, {{venue}}. RSVP by {{rsvp_date}}.',
   '["first_name","event_name","event_date","event_time","venue","rsvp_date"]'::jsonb, true)
ON CONFLICT DO NOTHING;
