/**
 * The mail wire model.
 *
 * One definition, imported by the API, the worker and the browser. Database
 * rows are snake_case and mapped once, in `@tupo/mail`.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Folders, labels, recipient kinds
 * ────────────────────────────────────────────────────────────────────────── */

/** Recipient-side mailbox folders. */
export const MAIL_FOLDERS = ['inbox', 'starred', 'sent', 'drafts', 'scheduled', 'archive', 'trash', 'spam'] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

export const MAIL_RECIPIENT_KINDS = ['to', 'cc', 'bcc'] as const;
export type MailRecipientKind = (typeof MAIL_RECIPIENT_KINDS)[number];

export const MAIL_MESSAGE_KINDS = ['new', 'reply', 'reply_all', 'forward'] as const;
export type MailMessageKind = (typeof MAIL_MESSAGE_KINDS)[number];

/** Per-recipient delivery state (FR-MAIL-8). */
export const MAIL_DELIVERY_STATUSES = [
  'queued', 'sending', 'sent', 'delivered', 'bounced', 'failed', 'suppressed',
] as const;
export type MailDeliveryStatus = (typeof MAIL_DELIVERY_STATUSES)[number];

export const MAIL_CHANNELS = ['in_app', 'smtp'] as const;
export type MailChannel = (typeof MAIL_CHANNELS)[number];

export const MAIL_LIST_ORIGINS = ['manual', 'mis:all', 'mis:role:Student', 'mis:role:Parent',
  'mis:role:Staff', 'mis:role:Moderator', 'mis:role:Admin', 'mis:space:staff', 'mis:space:students',
  'mis:space:parents'] as const;

export const MAIL_CAMPAIGN_STATUSES = [
  'draft', 'pending_approval', 'approved', 'scheduled', 'sending', 'sent', 'failed', 'cancelled',
] as const;
export type MailCampaignStatus = (typeof MAIL_CAMPAIGN_STATUSES)[number];

/* ────────────────────────────────────────────────────────────────────────── *
 * Limits & policy
 * ────────────────────────────────────────────────────────────────────────── */

export const MAIL_MAX_SUBJECT = 300;
export const MAIL_MAX_BODY_HTML = 200_000;
export const MAIL_MAX_RECIPIENTS = 200;
export const MAIL_MAX_ATTACHMENTS = 20;
export const MAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAIL_PAGE_SIZE = 30;
export const MAIL_MAX_PAGE_SIZE = 100;

/** A bulk send above this many recipients needs approval (FR-MAIL-10). */
export const MAIL_APPROVAL_THRESHOLD = 200;

/** SMTP relay rate limit — messages per minute (FR-MAIL-7). */
export const MAIL_SMTP_RATE_PER_MIN = 60;

/** `{{merge_field}}` grammar for templates and campaigns (FR-MAIL-5/6). */
export const MAIL_MERGE_PATTERN = /\{\{\s*([a-z0-9_]{1,40})\s*\}\}/gi;

/** Fields Tupo can always populate from the local user mirror. */
export const MAIL_BUILTIN_MERGE_FIELDS = ['name', 'first_name', 'email', 'role'] as const;

/* ────────────────────────────────────────────────────────────────────────── *
 * Wire shapes
 * ────────────────────────────────────────────────────────────────────────── */

export interface MailPerson {
  userId: string | null;
  name: string;
  address: string;
  avatarUrl?: string | null;
}

export interface MailLabel {
  id: string;
  name: string;
  color: string;
  ordinal: number;
  isSystem: boolean;
  /** Unread threads carrying this label — inbox only. */
  unread?: number;
}

export interface MailAttachment {
  id: string;
  fileId: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'video' | 'audio' | 'document' | 'other';
}

/** A row in a mailbox list — one thread, summarised for the viewer. */
export interface MailThreadSummary {
  threadId: string;
  subject: string;
  snippet: string;
  lastMessageAt: string;
  messageCount: number;
  hasAttachments: boolean;
  /** Distinct participants, most recent first, resolved for display. */
  participants: MailPerson[];
  /** Viewer-scoped — from the viewer's `mail_recipients` row for the thread. */
  unread: boolean;
  starred: boolean;
  folder: MailFolder;
  labels: string[];
  /** Only present in Sent/Drafts/Scheduled: the aggregate delivery state. */
  delivery?: MailDeliveryStatus;
  scheduledAt?: string | null;
  isDraft?: boolean;
}

export interface MailMessageView {
  id: string;
  threadId: string;
  from: MailPerson;
  to: MailPerson[];
  cc: MailPerson[];
  bcc: MailPerson[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  snippet: string;
  kind: MailMessageKind;
  parentId: string | null;
  isDraft: boolean;
  scheduledAt: string | null;
  sentAt: string | null;
  createdAt: string;
  attachments: MailAttachment[];
  campaignId: string | null;
  /** Viewer-scoped mailbox state for this message's own recipient row. */
  mine: {
    recipientId: string | null;
    isRead: boolean;
    isStarred: boolean;
    folder: MailFolder | null;
    labels: string[];
  } | null;
  /** Sender-only: per-recipient delivery, for the tracking sheet (FR-MAIL-8). */
  deliverySummary?: {
    total: number;
    queued: number;
    sent: number;
    delivered: number;
    bounced: number;
    failed: number;
    suppressed: number;
  };
}

export interface MailThreadView {
  threadId: string;
  subject: string;
  messages: MailMessageView[];
  labels: string[];
}

export interface MailRecipientDelivery {
  recipientId: string;
  name: string;
  address: string;
  kind: MailRecipientKind;
  channel: MailChannel;
  status: MailDeliveryStatus;
  error: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  events: Array<{ type: string; at: string; detail: Record<string, unknown> }>;
}

export interface MailDistributionList {
  id: string;
  name: string;
  slug: string;
  description: string;
  origin: string;
  isActive: boolean;
  memberCount: number;
  syncedAt: string | null;
  createdAt: string;
}

export interface MailTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  variables: string[];
  isShared: boolean;
  createdBy: string | null;
  updatedAt: string;
}

export interface MailCampaignView {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  templateId: string | null;
  from: MailPerson;
  status: MailCampaignStatus;
  listIds: string[];
  extraRecipients: Array<{ address: string; name: string; mergeVars: Record<string, string> }>;
  scheduledAt: string | null;
  requiresApproval: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  totalRecipients: number;
  counts: Record<string, number>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface MailPrefs {
  displayName: string | null;
  signatureHtml: string;
  signatureEnabled: boolean;
  /** Whether mail to this user is also delivered as a real email. */
  emailCopies: boolean;
  /** Read-only: whether this deployment has real-email delivery switched on. */
  emailDeliveryAvailable?: boolean;
}

export interface MailboxCounts {
  inbox: number;
  starred: number;
  drafts: number;
  scheduled: number;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Request payloads
 * ────────────────────────────────────────────────────────────────────────── */

export interface MailComposePayload {
  to: string[];               // addresses or "userId:<id>"
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  attachments?: Array<{ fileId: string; name: string; mime: string; size: number }>;
  /** Reply/forward within an existing thread. */
  threadId?: string;
  parentId?: string;
  kind?: MailMessageKind;
  /** Save as a draft instead of sending. */
  draft?: boolean;
  /** ISO timestamp — schedule for later (FR-MAIL-10). */
  scheduledAt?: string | null;
  /** Reuse a saved draft row rather than creating a new message. */
  draftId?: string;
}

export interface MailCampaignPayload {
  name?: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  templateId?: string | null;
  listIds: string[];
  extraRecipients?: Array<{ address: string; name?: string; mergeVars?: Record<string, string> }>;
  scheduledAt?: string | null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * AI assistant (FR-MAIL — AI drafting, replying, planning)
 *
 * Runs through the same openai → gemini → groq → glm fallback chain as Meet
 * and the MIS. Every result records which provider answered.
 * ────────────────────────────────────────────────────────────────────────── */

export const MAIL_AI_ACTIONS = [
  'draft',      // write a message from a short instruction
  'reply',      // draft a reply to the open thread
  'improve',    // tighten wording, keep meaning and length
  'formal',     // raise the register
  'friendly',   // warm it up
  'concise',    // shorten
  'expand',     // flesh out bullet points into prose
  'grammar',    // fix spelling and grammar only
  'translate',  // render in another language
] as const;
export type MailAiAction = (typeof MAIL_AI_ACTIONS)[number];

export interface MailAiComposeRequest {
  action: MailAiAction;
  /** Free-text instruction (draft/reply), or target language (translate). */
  instruction?: string;
  /** The current editor contents, as plain text. */
  currentText?: string;
  subject?: string;
  /** Display names of the people being written to, for salutation/register. */
  recipients?: string[];
  /** When replying/summarising in a thread, its id — the server pulls the text. */
  threadId?: string;
  /** The sender's own display name, for sign-off. */
  senderName?: string;
  tone?: string;
}

export interface MailAiComposeResult {
  /** Ready-to-insert HTML. */
  html: string;
  /** A one-line note on what changed, shown before the user accepts. */
  note: string;
  providerUsed: string;
}

export interface MailAiSubjectResult {
  suggestions: string[];
  providerUsed: string;
}

export interface MailAiThreadSummary {
  summary: string;
  keyPoints: string[];
  actionItems: Array<{ text: string; owner: string | null; due: string | null }>;
  /** Whether the thread seems to need a reply from the reader. */
  needsReply: boolean;
  providerUsed: string;
}

export interface MailAiSmartReplies {
  replies: Array<{ intent: string; text: string }>;
  providerUsed: string;
}

export interface MailAiCampaignDraft {
  subject: string;
  bodyHtml: string;
  mergeFields: string[];
  providerUsed: string;
}

/** Strip a run of Re:/Fwd: prefixes and fold case — used for thread grouping. */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fw|fwd)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .trim()
    .toLowerCase()
    .slice(0, MAIL_MAX_SUBJECT);
}
