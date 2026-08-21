import { z } from 'zod';

/**
 * Tupo Meet — the contract shared by the API, the realtime gateway, the worker
 * and the browser (SRS §6.5, §10).
 *
 * Everything a client is allowed to assume about a meeting lives here, so a
 * setting cannot be defaulted one way on the server and another in the UI.
 */

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

/**
 * How the *media* moves. Application state — roster, lobby, chat, captions —
 * is carried by tupo-realtime either way, so every feature in this module is
 * identical across both.
 *
 *  mesh — N×(N−1) peer connections, no media server, Cloudflare TURN for NAT
 *         traversal. Lowest latency and zero infrastructure, but uplink grows
 *         linearly with participants, so it is hard-capped (MESH_MAX_PARTICIPANTS).
 *  cloudflare — Cloudflare Realtime. One uplink per publisher however large the
 *         audience, simulcast layers selected per subscriber, and video pulled
 *         only for the tiles actually on screen. The production path, and the
 *         only one that reaches the figures in SRS §10.4.
 */
export const MEET_TRANSPORTS = ['mesh', 'cloudflare'] as const;
export type MeetTransport = (typeof MEET_TRANSPORTS)[number];

/** What the *meeting* asks for. `auto` lets the server pick from capacity + availability. */
export const MEET_MEDIA_MODES = ['auto', 'mesh', 'cloudflare'] as const;
export type MeetMediaMode = (typeof MEET_MEDIA_MODES)[number];

/** True for the transports that route through a media server. */
export const isSfuTransport = (t: MeetTransport): boolean => t === 'cloudflare';

/* ------------------------------------------------------------------ *
 * Cloudflare Realtime SFU
 * ------------------------------------------------------------------ */

/**
 * Track naming.
 *
 * Cloudflare's SFU has no concept of a room — it is a pub/sub of *sessions* and
 * *tracks*, and the application decides how subscribers find what to play.
 * Tupo already owns the roster, so names are derived from the participant id
 * rather than exchanged: knowing who is in the meeting is enough to know what
 * their tracks are called. That removes an entire round of signalling and, more
 * importantly, a class of bug where a subscriber and a publisher disagree.
 */
export const sfuTrackName = (
  participantId: string, kind: 'cam' | 'mic' | 'screen' | 'screenaudio',
): string => `${kind}-${participantId}`;

export const parseSfuTrackName = (
  name: string,
): { kind: 'cam' | 'mic' | 'screen' | 'screenaudio'; participantId: string } | null => {
  const match = /^(cam|mic|screen|screenaudio)-(.+)$/.exec(name);
  if (!match) return null;
  return {
    kind: match[1] as 'cam' | 'mic' | 'screen' | 'screenaudio',
    participantId: match[2]!,
  };
};

/**
 * A Cloudflare session goes stale after 30 seconds without media, so a
 * participant who is muted with their camera off must still be kept alive.
 * Well inside that, and cheap — it is one HTTP call.
 */
export const SFU_KEEPALIVE_MS = 20_000;

/** Cloudflare accepts at most this many track objects in one call. */
export const SFU_MAX_TRACKS_PER_CALL = 64;

/**
 * Above this, mesh stops being a good idea: each publisher uploads one stream
 * per *other* participant, so a 5th camera means a 4× uplink on every laptop in
 * the room. The API refuses to place a larger meeting on mesh and says why
 * rather than letting the call quietly fall apart.
 */
export const MESH_MAX_PARTICIPANTS = 4;

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

export const MEETING_STATUSES = ['scheduled', 'live', 'ended', 'cancelled'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/** Ordered least → most privileged; `atLeast()` below relies on the order. */
export const MEET_ROLES = ['attendee', 'presenter', 'cohost', 'host'] as const;
export type MeetRole = (typeof MEET_ROLES)[number];

export function meetRoleAtLeast(role: MeetRole, floor: MeetRole): boolean {
  return MEET_ROLES.indexOf(role) >= MEET_ROLES.indexOf(floor);
}

/**
 * The participant state machine (SRS §10.2, mirroring the proctoring session
 * states). `knocking` and `lobby` are distinct: knocking means the host has
 * been asked, lobby means the meeting has not started yet.
 */
export const PARTICIPANT_STATES = [
  'lobby', 'knocking', 'connecting', 'active', 'reconnecting', 'left', 'denied', 'removed',
] as const;
export type ParticipantState = (typeof PARTICIPANT_STATES)[number];

export const CONNECTION_QUALITIES = ['excellent', 'good', 'poor', 'lost'] as const;
export type ConnectionQuality = (typeof CONNECTION_QUALITIES)[number];

/* ------------------------------------------------------------------ *
 * Events — the proctoring event model, verbatim (SRS §10.2)
 * ------------------------------------------------------------------ */

export const MEET_EVENT_SEVERITIES = ['info', 'warn', 'critical'] as const;
export type MeetEventSeverity = (typeof MEET_EVENT_SEVERITIES)[number];

export const MEET_EVENT_TYPES = [
  'meeting.created', 'meeting.started', 'meeting.ended', 'meeting.locked', 'meeting.unlocked',
  'meeting.renamed', 'meeting.deleted',
  'participant.knocked', 'participant.admitted', 'participant.denied',
  'participant.joined', 'participant.left', 'participant.removed',
  'participant.promoted', 'participant.demoted',
  'media.muted', 'media.unmuted', 'media.camera_on', 'media.camera_off',
  'share.started', 'share.stopped',
  'recording.started', 'recording.stopped',
  'transcription.started', 'transcription.stopped',
  'ai.invited', 'ai.dismissed', 'ai.artifact_generated',
  'network.degraded', 'network.recovered', 'network.dropped',
  'breakout.opened', 'breakout.closed', 'breakout.assigned',
  'poll.opened', 'poll.closed',
  'hand.raised', 'hand.lowered',
] as const;
export type MeetEventType = (typeof MEET_EVENT_TYPES)[number];

/** Severity is a property of the event type, not a caller's choice — so the
 *  same thing happening twice is never logged at two different severities. */
export const MEET_EVENT_SEVERITY: Record<string, MeetEventSeverity> = {
  'participant.removed': 'warn',
  'participant.denied': 'warn',
  'recording.started': 'warn',
  'recording.stopped': 'warn',
  'transcription.started': 'warn',
  'ai.invited': 'warn',
  'network.degraded': 'warn',
  'network.dropped': 'critical',
  'meeting.locked': 'warn',
};
export const severityFor = (type: string): MeetEventSeverity =>
  MEET_EVENT_SEVERITY[type] ?? 'info';

/* ------------------------------------------------------------------ *
 * Media tuning (SRS §10.3)
 * ------------------------------------------------------------------ */

/**
 * The simulcast ladder. Three spatial layers, so the SFU (or, on mesh, the
 * receiver's preference) can pick a layer that matches the tile it will be
 * painted into — a 160px thumbnail has no use for 720p.
 */
export const SIMULCAST_LAYERS = [
  { rid: 'q', name: 'low', width: 320, height: 180, maxBitrate: 150_000, scaleDownBy: 4, maxFramerate: 15 },
  { rid: 'h', name: 'medium', width: 640, height: 360, maxBitrate: 500_000, scaleDownBy: 2, maxFramerate: 25 },
  { rid: 'f', name: 'high', width: 1280, height: 720, maxBitrate: 1_500_000, scaleDownBy: 1, maxFramerate: 30 },
] as const;

export type VideoQuality = 'off' | 'low' | 'medium' | 'high';

/** Reversible degradation ladder (SRS §10.3). Index 0 is the healthiest state. */
export const DEGRADATION_LADDER: VideoQuality[] = ['high', 'medium', 'low', 'off'];

/** The rung boundaries, in rendered pixels. */
const RUNG_BOUNDARIES = { medium: 240, high: 640 } as const;

/**
 * How far a tile must fall *below* a boundary before it gives up the rung it
 * already holds. Without this a tile whose width rests on a boundary — which
 * is not exotic, it is what a two-up grid at a common window size produces —
 * flips between two rungs on every layout settle. Each flip is a real
 * unsubscribe and re-subscribe on the SFU, so the stream is torn down and
 * rebuilt repeatedly and almost no video arrives.
 *
 * Stepping *up* stays immediate: arriving at a bigger tile should sharpen at
 * once, and it cannot oscillate because the step down is what is damped.
 */
const STEP_DOWN_MARGIN = 0.12;

const RUNG_ORDER: VideoQuality[] = ['off', 'low', 'medium', 'high'];

/**
 * Map a rendered tile's pixel width to the layer that should feed it.
 *
 * Pass the quality this tile is currently receiving to get the hysteresis;
 * omit it for a plain, memoryless mapping.
 */
export function qualityForWidth(width: number, previous?: VideoQuality): VideoQuality {
  if (width <= 0) return 'off';
  const raw: VideoQuality =
    width < RUNG_BOUNDARIES.medium ? 'low'
    : width < RUNG_BOUNDARIES.high ? 'medium'
    : 'high';

  if (!previous || previous === 'off' || raw === previous) return raw;
  if (RUNG_ORDER.indexOf(raw) > RUNG_ORDER.indexOf(previous)) return raw;

  // Stepping down — only once the tile is clear of the boundary it is leaving.
  const boundary = previous === 'high' ? RUNG_BOUNDARIES.high : RUNG_BOUNDARIES.medium;
  return width < boundary * (1 - STEP_DOWN_MARGIN) ? raw : previous;
}

export const AUDIO_BITRATE = 32_000;
export const SCREENSHARE_BITRATE = 2_500_000;

/**
 * How many tiles actually carry video at once. Beyond this the grid shows
 * avatars, which is what keeps the subscription count bounded in a 100-person
 * meeting (SRS §10.4) — and what makes the difference between 100 Mbps and
 * 3 Mbps of downlink on a school connection.
 */
export const MAX_VIDEO_TILES = 25;

/**
 * Hard ceilings, enforced server-side at join, and a function of the transport.
 *
 * Peer-to-peer is capped at a handful because every publisher uploads once per
 * peer. Through an SFU each publisher uploads once regardless of audience, and
 * the binding constraint moves to the *subscriber's* downlink — which is
 * already handled by only ever rendering MAX_VIDEO_TILES of them and
 * subscribing to nothing else. So these numbers are deliberately large: the
 * cost of a 400-person assembly is one uplink each and 25 downlinks, not 400.
 */
export const CAPACITY: Record<MeetTransport, { video: number; audio: number }> = {
  mesh: { video: MESH_MAX_PARTICIPANTS, audio: MESH_MAX_PARTICIPANTS },
  cloudflare: { video: 500, audio: 2000 },
};

/** Retained for callers that predate per-transport capacity. */
export const MAX_VIDEO_PARTICIPANTS = 500;
export const MAX_AUDIO_PARTICIPANTS = 2000;
export const MAX_CONCURRENT_SHARES = 2;

export const capacityFor = (transport: MeetTransport, audioOnly: boolean): number =>
  audioOnly ? CAPACITY[transport].audio : CAPACITY[transport].video;

/** Webinar mode: how many may publish video while everyone else listens. */
export const WEBINAR_PUBLISHER_CAP = 5;

/* ------------------------------------------------------------------ *
 * Layouts & reactions
 * ------------------------------------------------------------------ */

export const MEET_LAYOUTS = ['grid', 'speaker', 'sidebar', 'spotlight'] as const;
export type MeetLayout = (typeof MEET_LAYOUTS)[number];

export const MEET_REACTIONS = ['👍', '👏', '❤️', '😂', '😮', '🎉', '🤔', '👋'] as const;
export type MeetReaction = (typeof MEET_REACTIONS)[number];

/** Reactions live this long on screen and are never persisted. */
export const REACTION_TTL_MS = 4_000;

/* ------------------------------------------------------------------ *
 * Admission policy — who is allowed through the door at all
 * ------------------------------------------------------------------ */

/**
 * Four levels, from tightest to most open. This decides *eligibility*; the
 * lobby decides *timing*. They are separate on purpose — "anyone in the school
 * may attend, but I want to see them arrive" is an ordinary thing to want, and
 * a single combined setting cannot express it.
 *
 *  permission     — must hold MEET_JOIN. The institutional default: staff and
 *                   pupils can attend, an unassigned account cannot.
 *  invited        — must be on the invite list, or a member of the originating
 *                   conversation. Everyone else is refused outright, so a
 *                   forwarded link is useless.
 *  authenticated  — any signed-in Tupo user, invited or not. For all-staff
 *                   briefings and assemblies where chasing an invite list is
 *                   the only thing standing between people and the meeting.
 *  public         — anyone with the link, including people with no NGA account.
 *                   They type a name and are given an anonymous participant
 *                   that exists only for this meeting. Always lobbied.
 */
export const MEET_ADMISSION_POLICIES = [
  'permission', 'invited', 'authenticated', 'public',
] as const;
export type MeetAdmissionPolicy = (typeof MEET_ADMISSION_POLICIES)[number];

export const ADMISSION_POLICY_LABELS: Record<MeetAdmissionPolicy, string> = {
  permission: 'People allowed to join meetings',
  invited: 'Invited people only',
  authenticated: 'Anyone signed in to Tupo',
  public: 'Anyone with the link, including guests',
};

export const ADMISSION_POLICY_HINTS: Record<MeetAdmissionPolicy, string> = {
  permission: 'Anyone whose role lets them join meetings. The usual choice for a lesson.',
  invited: 'Only people you invited, or members of the conversation this started from.',
  authenticated: 'Any signed-in member of the institution. Good for assemblies and briefings.',
  public: 'People with no account can join by typing a name. They always wait in the lobby.',
};

/** Guests hold this and nothing else. Everything else is refused server-side. */
export const GUEST_PERMISSIONS: readonly string[] = ['MEET_JOIN'];

export const guestJoinSchema = z.object({
  displayName: z.string().trim().min(2, 'Please enter your name.').max(60),
});

/* ------------------------------------------------------------------ *
 * Participant categories — the admission policy, as a person picks it
 * ------------------------------------------------------------------ */

/**
 * The three choices offered when a meeting is created. They are the same
 * mechanism as `admissionPolicy`, named the way the decision is actually made:
 * *who is this for?* rather than *what rule applies?*.
 *
 * `permission` is not offered here. It remains a valid stored value — meetings
 * created before categories existed use it, and the host console still shows
 * it — but "whoever the role model happens to allow" is a rule, not an
 * audience, and it is not a useful thing to ask someone at creation time.
 */
export const MEET_CATEGORIES = ['private', 'loggedIn', 'public'] as const;
export type MeetCategory = (typeof MEET_CATEGORIES)[number];

export const CATEGORY_TO_POLICY: Record<MeetCategory, MeetAdmissionPolicy> = {
  private: 'invited',
  loggedIn: 'authenticated',
  public: 'public',
};

export const POLICY_TO_CATEGORY: Record<MeetAdmissionPolicy, MeetCategory> = {
  invited: 'private',
  authenticated: 'loggedIn',
  public: 'public',
  // Nearest honest equivalent for a meeting created before categories existed.
  permission: 'loggedIn',
};

export const CATEGORY_META: Record<MeetCategory, {
  label: string; hint: string; warning?: string;
}> = {
  private: {
    label: 'Private',
    hint: 'Only the people you choose. A forwarded link will not work.',
  },
  loggedIn: {
    label: 'Anyone signed in',
    hint: 'Any member of the institution with the link. Good for assemblies and briefings.',
  },
  public: {
    label: 'Public',
    hint: 'Anyone with the link, including people with no account. They type a name to join.',
    warning: 'Guests always wait in the lobby, and no account is created for them.',
  },
};

/* ------------------------------------------------------------------ *
 * Naming
 * ------------------------------------------------------------------ */

/**
 * The name a meeting is proposed with.
 *
 * Every meeting gets one rather than defaulting to "Meeting", because a list of
 * eleven identical rows is unusable — and a timestamp is the one thing that is
 * always true and always distinguishing. It is only ever a *proposal*: the
 * field is editable everywhere it appears.
 */
export function defaultMeetingName(
  at: Date = new Date(),
  kind: 'instant' | 'scheduled' = 'instant',
): string {
  const day = at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${kind === 'instant' ? 'Meeting' : 'Meeting'} · ${day}, ${time}`;
}

/**
 * True when a title is still the untouched proposal, so the AI may replace it.
 *
 * Matched on the separator rather than on the date, because
 * `toLocaleDateString` puts the month first in some locales and the day first
 * in others — anchoring on a digit worked in exactly half the world.
 */
export const isDefaultMeetingName = (title: string): boolean => {
  const trimmed = title.trim();
  return trimmed === 'Meeting' || /^Meeting · .+/.test(trimmed);
};

export const renameMeetingSchema = z.object({
  title: z.string().trim().min(1, 'A meeting needs a name.').max(200),
});

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

/**
 * Where the recording is produced.
 *
 * There is one answer: the host's browser composites the stage onto a canvas,
 * mixes the audio, and uploads the result. Cloudflare Realtime is an SFU, not a
 * recording product — it routes tracks and offers no server-side compositing —
 * so a recording has to be made somewhere with a view of the meeting, and the
 * host's browser is the only such place.
 *
 * Honest about its limits, which the UI states: it records what the host could
 * see, and it stops if the host leaves.
 *
 * `server` remains in the union only so recordings written before this was
 * settled still parse. Nothing produces one.
 */
export const RECORDING_MODES = ['client', 'server'] as const;
export type RecordingMode = (typeof RECORDING_MODES)[number];

export const RECORDING_STATUSES = ['recording', 'processing', 'ready', 'failed'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export interface MeetRecording {
  id: string;
  meetingId: string;
  fileId: string | null;
  mode: RecordingMode;
  status: RecordingStatus;
  startedByName?: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  startedAt: string;
  endedAt: string | null;
}

/** Every recording for a meeting lands under one prefix in the file store. */
export const meetingFolder = (meetingId: string): string => `meetings/${meetingId}`;

/** Guards the folder a client may ask an upload to land in. */
export const MEETING_FOLDER_PATTERN = /^meetings\/[0-9]{1,25}$/;

export const attachRecordingSchema = z.object({
  fileId: z.string().min(1),
  durationSeconds: z.number().int().min(0).max(60 * 60 * 24),
  sizeBytes: z.number().int().min(1),
});

export const startRecordingSchema = z.object({
  mode: z.enum(RECORDING_MODES).optional(),
});

/** A recording larger than this is refused before the upload starts. */
export const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/**
 * Per-meeting settings, the analogue of TaskMentor's `ProctoringSettings`.
 * Every field has a default, so an older row missing a key still parses — which
 * is what lets settings be added without a migration.
 */
export const meetSettingsSchema = z.object({
  /* Admission */
  /** Who is eligible at all. The lobby below decides when they get in. */
  admissionPolicy: z.enum(MEET_ADMISSION_POLICIES).default('permission'),
  lobbyEnabled: z.boolean().default(true),
  /** Superseded by `admissionPolicy: 'public'`. Retained so meetings created
   *  before the policy existed still parse; nothing reads it. */
  guestsAllowed: z.boolean().default(false),
  /** Nobody but the host may enter until the host is present (FR-MEET-19). */
  waitForHost: z.boolean().default(true),
  locked: z.boolean().default(false),
  /** Members of the originating conversation skip the lobby. */
  trustConversationMembers: z.boolean().default(true),

  /* Defaults on arrival */
  joinMuted: z.boolean().default(true),
  joinCameraOff: z.boolean().default(false),

  /* What attendees may do */
  allowChat: z.boolean().default(true),
  allowReactions: z.boolean().default(true),
  allowScreenShare: z.boolean().default(true),
  allowAttendeeUnmute: z.boolean().default(true),
  allowRename: z.boolean().default(false),

  /* Recording & transcript */
  recordingEnabled: z.boolean().default(false),
  autoRecord: z.boolean().default(false),
  transcriptionEnabled: z.boolean().default(false),
  captionsDefaultOn: z.boolean().default(false),

  /* AI (§5 of the implementation plan) */
  aiAssistantEnabled: z.boolean().default(false),
  aiAutoSummary: z.boolean().default(true),
  aiActionItems: z.boolean().default(true),
  aiPostMeetingMinutes: z.boolean().default(true),
  aiEngagementReport: z.boolean().default(false),
  aiLessonFollowUp: z.boolean().default(false),

  /* Shape of the room */
  webinarMode: z.boolean().default(false),
  audioOnly: z.boolean().default(false),
  /** Cap the ladder for everyone — a data-saver the host can impose. */
  maxVideoQuality: z.enum(['low', 'medium', 'high']).default('high'),

  /* Language */
  primaryLanguage: z.string().default('en-US'),
  translationEnabled: z.boolean().default(false),
});

export type MeetSettings = z.infer<typeof meetSettingsSchema>;

export const DEFAULT_MEET_SETTINGS: MeetSettings = meetSettingsSchema.parse({});

/** Tolerant parse — an unknown or malformed blob becomes the defaults, never a throw. */
export function parseMeetSettings(raw: unknown): MeetSettings {
  const result = meetSettingsSchema.safeParse(raw ?? {});
  return result.success ? result.data : DEFAULT_MEET_SETTINGS;
}

/* ------------------------------------------------------------------ *
 * Request schemas
 * ------------------------------------------------------------------ */

export const createMeetingSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).optional(),
  conversationId: z.string().optional(),
  scheduledStart: z.string().datetime().optional(),
  scheduledEnd: z.string().datetime().optional(),
  /** RFC 5545 RRULE, stored verbatim and expanded by the client. */
  recurrenceRule: z.string().max(500).optional(),
  mediaMode: z.enum(MEET_MEDIA_MODES).default('auto'),
  settings: meetSettingsSchema.partial().optional(),
  inviteeIds: z.array(z.string()).max(500).optional(),
});
export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;

export const updateMeetingSchema = createMeetingSchema.partial().extend({
  status: z.enum(MEETING_STATUSES).optional(),
});

export const joinMeetingSchema = z.object({
  /** Present only for guest join; ignored for authenticated users. */
  displayName: z.string().trim().min(1).max(80).optional(),
  deviceLabel: z.string().max(200).optional(),
  /** The client's own view of what it can do, used to pick a transport. */
  capabilities: z.object({
    video: z.boolean().default(true),
    audio: z.boolean().default(true),
    screenShare: z.boolean().default(false),
    speechRecognition: z.boolean().default(false),
  }).partial().optional(),
});

export const hostCommandSchema = z.object({
  action: z.enum([
    'mute', 'mute_all', 'unmute_request', 'camera_off', 'remove', 'promote', 'demote',
    'lock', 'unlock', 'admit', 'deny', 'admit_all', 'spotlight', 'unspotlight',
    'disable_chat', 'enable_chat', 'disable_share', 'enable_share', 'end',
  ]),
  targetId: z.string().optional(),
  reason: z.string().max(500).optional(),
});
export type HostCommand = z.infer<typeof hostCommandSchema>;

export const transcriptSegmentSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  lang: z.string().max(20).default('en-US'),
  isFinal: z.boolean().default(true),
  confidence: z.number().min(0).max(1).optional(),
  startedAt: z.string().datetime().optional(),
});

export const meetChatSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  /** Direct message inside the meeting; absent means everyone. */
  toParticipantId: z.string().optional(),
});

export const pollSchema = z.object({
  question: z.string().trim().min(1).max(500),
  options: z.array(z.string().trim().min(1).max(200)).min(2).max(10),
  /** A quiz records a right answer and is scored; a poll just counts. */
  kind: z.enum(['poll', 'quiz']).default('poll'),
  correctOptionIndex: z.number().int().min(0).optional(),
  anonymous: z.boolean().default(false),
  multipleChoice: z.boolean().default(false),
});

export const breakoutPlanSchema = z.object({
  rooms: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    participantIds: z.array(z.string()).default([]),
  })).min(1).max(50),
  durationMinutes: z.number().int().min(1).max(240).optional(),
  /** Spread everyone evenly and ignore the supplied assignments. */
  autoAssign: z.boolean().default(false),
});

/* ------------------------------------------------------------------ *
 * AI
 * ------------------------------------------------------------------ */

export const MEET_AI_ARTIFACT_KINDS = [
  'summary', 'minutes', 'action_items', 'decisions', 'chapters',
  'qa_answer', 'title', 'engagement', 'lesson_followup', 'agenda', 'translation',
] as const;
export type MeetAiArtifactKind = (typeof MEET_AI_ARTIFACT_KINDS)[number];

/** The AI notetaker's identity in the roster. Not a user row — a synthetic participant. */
export const AI_PARTICIPANT_ID = 'tupo-ai';
export const AI_PARTICIPANT_NAME = 'Tupo AI';

/** Rolling summary cadence. Batched deliberately: per-utterance calls would burn
 *  quota on four providers and tell the room nothing it did not already know. */
export const AI_SUMMARY_INTERVAL_MS = 90_000;
export const AI_MIN_SEGMENTS_FOR_SUMMARY = 8;

export interface MeetActionItem {
  text: string;
  owner?: string;
  ownerParticipantId?: string;
  due?: string;
  confidence?: number;
}

export interface MeetDecision {
  decision: string;
  context?: string;
  quote?: string;
}

export interface MeetChapter {
  title: string;
  startOffsetSeconds: number;
  summary: string;
}

export const askMeetingSchema = z.object({
  question: z.string().trim().min(1).max(1000),
});

/* ------------------------------------------------------------------ *
 * Notes — what a person decided to keep
 * ------------------------------------------------------------------ */

/**
 * Kept apart from the AI artifacts on purpose. An artifact is regenerated; a
 * note is not. Someone's own record of a meeting must never be overwritten by
 * the next summary run.
 */
export const NOTE_SOURCES = ['manual', 'capture', 'ai', 'tidied'] as const;
export type NoteSource = (typeof NOTE_SOURCES)[number];

export interface MeetNote {
  id: string;
  meetingId: string;
  participantId: string;
  authorName: string;
  body: string;
  source: NoteSource;
  /** What it said before the AI tidied it, so the original is recoverable. */
  originalBody?: string | null;
  providerUsed?: string | null;
  offsetSeconds: number | null;
  isShared: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  /** True when this note belongs to the person reading it. */
  isMine?: boolean;
}

export const createNoteSchema = z.object({
  body: z.string().trim().min(1).max(8000),
  source: z.enum(NOTE_SOURCES).default('manual'),
  isShared: z.boolean().default(false),
  pinned: z.boolean().default(false),
});

export const updateNoteSchema = z.object({
  body: z.string().trim().min(1).max(8000).optional(),
  isShared: z.boolean().optional(),
  pinned: z.boolean().optional(),
});

/** One-tap capture of what was just said, so a good point is not lost to typing. */
export const captureNoteSchema = z.object({
  /** How far back to reach. Default is about one exchange. */
  seconds: z.number().int().min(5).max(300).default(45),
  isShared: z.boolean().default(false),
});

/** How far back a capture reaches when the caller does not say. */
export const NOTE_CAPTURE_DEFAULT_SECONDS = 45;

/* ------------------------------------------------------------------ *
 * Join codes
 * ------------------------------------------------------------------ */

/**
 * Google-Meet-shaped `abc-defg-hij`. The alphabet excludes vowels (so a code
 * cannot spell a word) and the letters that read as digits in most fonts.
 */
const CODE_ALPHABET = 'bcdfghjkmnpqrstvwxyz';

export function generateJoinCode(random: () => number = Math.random): string {
  const pick = (n: number) => Array.from({ length: n },
    () => CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)]).join('');
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}

export const JOIN_CODE_PATTERN = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export const normalizeJoinCode = (raw: string): string =>
  raw.trim().toLowerCase().replace(/[^a-z]/g, '')
    .replace(/^(.{3})(.{4})(.{3}).*$/, '$1-$2-$3');

/* ------------------------------------------------------------------ *
 * Wire shapes
 * ------------------------------------------------------------------ */

export interface MeetParticipant {
  id: string;
  userId: string | null;
  name: string;
  avatarUrl?: string | null;
  role: MeetRole;
  state: ParticipantState;
  isGuest: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  screenSharing: boolean;
  /** Mesh only — the MediaStream id carrying this participant's screen. */
  screenStreamId?: string | null;
  /** Cloudflare only — the SFU session publishing this participant's tracks.
   *  Everyone needs it to subscribe, so it travels on the roster. */
  sfuSessionId?: string | null;
  handRaised: boolean;
  handRaisedAt?: string | null;
  speaking: boolean;
  connectionQuality: ConnectionQuality;
  /** True for the Tupo AI tile — the client renders it differently and never
   *  tries to open a peer connection to it. */
  isAi?: boolean;
  joinedAt: string;
}

export interface MeetSummaryPayload {
  meetingId: string;
  title: string;
  status: MeetingStatus;
  transport: MeetTransport;
  settings: MeetSettings;
  joinCode: string;
  roomName: string;
  hostId: string;
  startedAt?: string | null;
  endedAt?: string | null;
}

/** What `POST /api/meet/:id/join` returns — everything needed to open media. */
export interface MeetJoinTicket {
  meeting: MeetSummaryPayload;
  participantId: string;
  /** Present only for a guest join — the session they hold instead of an
   *  account. Scoped to one meeting and one participant row. */
  guestToken?: string;
  isGuest?: boolean;
  role: MeetRole;
  state: ParticipantState;
  transport: MeetTransport;
  /** Cloudflare only. The app secret never leaves the server, so the browser
   *  reaches the SFU through Tupo's own API rather than directly. */
  sfuEndpoint?: string;
  /** Both transports — they go straight into the RTCConfiguration. */
  iceServers: RTCIceServerLike[];
}

/** Structural copy of the DOM type, so this file stays importable on the server. */
export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}
