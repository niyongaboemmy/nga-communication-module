import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SessionClaims } from '@tupo/shared';
import { feedAudienceRoom, feedAudiencesForRole, feedPostRoom } from '@tupo/shared';

/**
 * Feed over the socket.
 *
 * The gateway only delivers here — every feed write goes through tupo-api,
 * which commits the row and then publishes `{rooms,event,payload}` on the
 * shared `tupo:chat` relay (see apps/realtime/src/index.ts). This file just
 * lets a client join the `feedpost:<id>` rooms for the posts currently on its
 * screen so those relayed events reach it, plus the `feedaudience:<band>`
 * rooms its role can see, so a brand-new post from anyone — not just a
 * followed page — appears live on the home feed (FR-FEED-7).
 *
 * No per-post ACL at subscribe time: FEED_VIEW is a baseline permission, the
 * payloads carry nothing a signed-in user could not fetch over REST, and the
 * feed list itself is already audience-filtered by the API.
 */

type FeedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

const MAX_SUBSCRIPTIONS = 200;

export function registerFeedHandlers(_io: Server, socket: FeedSocket): void {
  const user = socket.data.user as SessionClaims;
  const joined = new Set<string>();

  for (const audience of feedAudiencesForRole(user?.role)) {
    void socket.join(feedAudienceRoom(audience));
  }

  socket.on('feed:subscribe', async ({ postIds }, ack) => {
    const wanted = [...new Set(postIds ?? [])].filter(Boolean).slice(0, MAX_SUBSCRIPTIONS);
    for (const id of wanted) {
      if (joined.size >= MAX_SUBSCRIPTIONS) break;
      await socket.join(feedPostRoom(id));
      joined.add(id);
    }
    ack?.({ ok: true, subscribed: [...joined] });
  });

  socket.on('feed:unsubscribe', async ({ postIds }) => {
    for (const id of postIds ?? []) {
      await socket.leave(feedPostRoom(id));
      joined.delete(id);
    }
  });

  socket.on('disconnect', () => { joined.clear(); void user; });
}
