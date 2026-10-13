/**
 * The socket event catalogue (SRS §9.2). Client and server both import these
 * types, so an event can't be emitted with one payload and handled with
 * another. Phase 0 implements only the connection-level events; the message
 * events are declared here so Phase 1 has the contract waiting.
 */
import type { ChatClientToServerEvents, ChatServerToClientEvents } from './chatEvents.js';
import type { FeedClientToServerEvents, FeedServerToClientEvents } from './feedEvents.js';

export interface ServerToClientEvents extends ChatServerToClientEvents, FeedServerToClientEvents {
  'connection:ready': (p: { userId: string; socketId: string; serverTime: string }) => void;
  /**
   * One person's presence moved.
   *
   * `lastSeenAt` rides along rather than being fetched separately, because the
   * moment a dot goes grey is exactly the moment the UI needs to replace it
   * with "last seen just now" — a second round trip there is a visible gap.
   */
  'presence:update': (p: {
    userId: string; status: PresenceStatus; at: string; lastSeenAt?: string | null;
  }) => void;
  /**
   * This person's own status, on their own devices only (F-10): what they
   * chose and what everyone else therefore sees. Separate from
   * `presence:update` because "appear offline" shows others a grey dot while
   * the status picker still has to show the choice.
   */
  'presence:self': (p: { choice: PresenceChoice; status: PresenceStatus }) => void;
  'pong': (p: { at: string }) => void;
  'system:reconnect_required': (p: { reason: string }) => void;
  /**
   * The gateway is about to cut this socket off because the session is over:
   * the account was suspended, the person signed out of NGA MIS, or the token
   * expired. The client signs out rather than retrying forever.
   */
  'session:ended': (p: { reason: 'suspended' | 'signed_out' | 'expired' }) => void;
  /** Raised on the recipient's own user room. See AppNotification. */
  'notification:new': (p: AppNotification) => void;
  /**
   * Notifications were read on one of this person's devices (or by reading
   * what they were about). `ids: 'all'` after "mark all read". Carries the new
   * unread total so every bell agrees without refetching.
   */
  'notification:read': (p: { ids: string[] | 'all'; unread: number }) => void;
  /** This person's role, or what it allows, just changed: re-read permissions (F-07). */
  'access:changed': (p: { reason: 'role' | 'permissions' | 'status' }) => void;
  /**
   * This person's mailbox counters moved — read, moved or deleted on one of
   * their devices (delivered on `user:<id>`). Carries nothing: every client
   * refetches its own counts rather than trusting a pushed number.
   */
  'mail:counts': (p: { at: string }) => void;
}

/**
 * A notification, as it reaches the browser.
 *
 * `link` is always an in-app path, never an absolute URL — this is rendered as
 * a link, and an absolute one would make the notification store an
 * open-redirect that any feature could write into.
 */
export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  subjectType: string | null;
  subjectId: string | null;
  readAt: string | null;
  createdAt: string;
  /** On a live push: this delivery added one to the unread count (new, or re-opened). */
  fresh?: boolean;
}

export interface ClientToServerEvents extends ChatClientToServerEvents, FeedClientToServerEvents {
  'ping': (ack: (p: { at: string }) => void) => void;
  /** This tab's activity: `online` while used, `away` once idle or hidden. */
  'presence:set': (p: { status: PresenceStatus }, ack: (p: { ok: boolean }) => void) => void;
  /**
   * A status the person picked (F-10). It holds across every tab and device
   * until changed; `auto` hands control back to activity.
   */
  'presence:choose': (
    p: { choice: PresenceChoice },
    ack?: (p: { ok: boolean; choice: PresenceChoice; status: PresenceStatus }) => void,
  ) => void;

  /**
   * Keep this person's presence key alive.
   *
   * The key carries a 90-second TTL so that a browser killed mid-session
   * expires instead of showing green forever. That only works if a browser
   * which is still *there* says so — without this the presence key of a person
   * reading a long thread quietly expires and everyone watching sees them go
   * offline while they are looking straight at the screen.
   */
  'presence:heartbeat': (ack?: (p: { ok: boolean }) => void) => void;

  /**
   * Current presence for a specific set of people.
   *
   * Used by anything that renders a roster it did not get from the socket — the
   * members panel, a mention list — so it starts correct rather than starting
   * grey and waiting for someone to change state.
   */
  'presence:query': (
    p: { userIds: string[] },
    ack: (p: { presence: Record<string, PresenceSnapshot> }) => void,
  ) => void;
}

/** Presence as it travels: what they are, and when they were last here. */
export interface PresenceSnapshot {
  status: PresenceStatus;
  lastSeenAt: string | null;
}

export type PresenceStatus = 'online' | 'away' | 'busy' | 'in-a-meeting' | 'dnd' | 'offline';

/** What a person can pick for themselves; `auto` follows activity and meetings. */
export type PresenceChoice = 'auto' | 'busy' | 'dnd' | 'invisible';
export const PRESENCE_CHOICES: readonly PresenceChoice[] = ['auto', 'busy', 'dnd', 'invisible'];

export const PRESENCE_TTL_SECONDS = 90;
export const PRESENCE_HEARTBEAT_SECONDS = 45;
export const TYPING_TTL_SECONDS = 6;

/**
 * How often a client re-pulls the presence of the conversation it has open.
 *
 * Presence changes are fanned out to DM counterparts only (see dmPeerIdsOf) —
 * a channel's members are deliberately not an audience for them, because that
 * would be a packet per member per tab switch. So a group's "N online" is
 * pulled on this interval instead, slow enough to be free and fast enough that
 * the number is not visibly wrong.
 */
export const PRESENCE_REFRESH_MS = 60_000;

/**
 * Silence long enough to call someone away.
 *
 * Five minutes is the figure every product people already use has converged
 * on, and the reason is social rather than technical: shorter and you mark
 * someone away while they read, which teaches everyone to distrust the dot.
 */
export const IDLE_AFTER_MS = 5 * 60_000;

/** Redis key holding one person's live status. TTL'd — see PRESENCE_TTL_SECONDS. */
export const presenceKey = (userId: string) => `presence:${userId}`;

/**
 * Redis key holding when one person was last connected.
 *
 * Deliberately *not* TTL'd: "last seen" is only interesting once presence has
 * expired, so a key that died with it would answer every question with
 * silence. Postgres holds the durable copy (users.last_seen_at); this is the
 * cache in front of it, so the common case never touches the database.
 */
export const lastSeenKey = (userId: string) => `lastseen:${userId}`;

/**
 * Redis key saying a person has Tupo open, whatever anyone else is shown (F-10).
 * Never read for presence: only the push sender uses it, so someone who
 * appears offline, or hides their presence, is not also pushed to their phone
 * while they sit at an open tab. TTL'd like the presence key.
 */
export const connectedKey = (userId: string) => `connected:${userId}`;

/** Redis key holding the status a person picked. No TTL: it holds until changed. */
export const presenceChoiceKey = (userId: string) => `presence:choice:${userId}`;
