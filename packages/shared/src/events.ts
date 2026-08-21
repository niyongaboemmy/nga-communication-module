/**
 * The socket event catalogue (SRS §9.2). Client and server both import these
 * types, so an event can't be emitted with one payload and handled with
 * another. Phase 0 implements only the connection-level events; the message
 * events are declared here so Phase 1 has the contract waiting.
 */
import type { ChatClientToServerEvents, ChatServerToClientEvents } from './chatEvents.js';

export interface ServerToClientEvents extends ChatServerToClientEvents {
  'connection:ready': (p: { userId: string; socketId: string; serverTime: string }) => void;
  'presence:update': (p: { userId: string; status: PresenceStatus; at: string }) => void;
  'pong': (p: { at: string }) => void;
  'system:reconnect_required': (p: { reason: string }) => void;
  /** Raised on the recipient's own user room. See AppNotification. */
  'notification:new': (p: AppNotification) => void;
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
}

export interface ClientToServerEvents extends ChatClientToServerEvents {
  'ping': (ack: (p: { at: string }) => void) => void;
  'presence:set': (p: { status: PresenceStatus }, ack: (p: { ok: boolean }) => void) => void;
}

export type PresenceStatus = 'online' | 'away' | 'busy' | 'in-a-meeting' | 'dnd' | 'offline';

export const PRESENCE_TTL_SECONDS = 90;
export const PRESENCE_HEARTBEAT_SECONDS = 45;
export const TYPING_TTL_SECONDS = 6;
