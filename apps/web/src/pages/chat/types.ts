/**
 * The chat view model.
 *
 * Phase 0 declared these shapes locally so the UI could be built against
 * placeholder content before any endpoint existed. They are now aliases of the
 * wire types in `@tupo/shared` — the same definitions the API and the realtime
 * gateway compile against.
 *
 * Keeping the local names is deliberate: every component already speaks
 * `Conversation` and `Message`, and a file of aliases is a smaller, more
 * reviewable change than renaming a type across a dozen files. It also leaves
 * one obvious place to put a genuinely view-only field if one is ever needed.
 */

export type {
  ConversationSummary as Conversation,
  ConversationType as ConversationKind,
  WireMessage as Message,
  WireMember as Member,
  WireReaction as Reaction,
  WireAttachment as Attachment,
  MessageType,
  DeliveryState as MessageStatus,
  NotificationLevel,
  MemberRole,
  TypingUser,
} from '@tupo/shared';

/** Presence as the UI renders it. The server's vocabulary is wider — see
 *  `PresenceStatus` — and anything unrecognised collapses to offline. */
export type Presence = 'online' | 'away' | 'busy' | 'offline';

export function toPresence(raw: string | null | undefined): Presence {
  switch (raw) {
    case 'online': return 'online';
    case 'away': return 'away';
    // "In a meeting" and "do not disturb" both mean *here but unavailable*,
    // which is what the busy dot says. Inventing two more colours for states
    // people read as one would make the legend longer, not the UI clearer.
    case 'busy':
    case 'dnd':
    case 'in-a-meeting': return 'busy';
    default: return 'offline';
  }
}
