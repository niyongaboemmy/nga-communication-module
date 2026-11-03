import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SessionClaims } from '@tupo/shared';
import { feedAudienceRoom, feedAudiencesForRole, feedPostRoom, feedReelRoom } from '@tupo/shared';
import { getPool } from '@tupo/db';

/**
 * Feed over the socket.
 *
 * The gateway only delivers here — every feed write goes through tupo-api,
 * which commits the row and then publishes `{rooms,event,payload}` on the
 * shared `tupo:chat` relay (see apps/realtime/src/index.ts). This file lets a
 * client join the `feedpost:<id>` rooms for the posts on its screen so those
 * relayed events reach it, plus the `feedaudience:<band>` rooms its role can
 * see, so a brand-new post appears live on the home feed (FR-FEED-7).
 *
 * A post's room is joined only if the post is visible to this person — the
 * same rule as the API's loadVisiblePost: published, page not deleted, and
 * both the post's and the page's audience include their role; or they are on
 * the page's team (X-02). Otherwise a staff-only post's edits and comments
 * would reach anyone who guessed its id.
 *
 * The room budget is least-recently-used: a long scroll keeps getting live
 * updates for what is on screen instead of silently stopping at the 200th.
 */

type FeedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type RoleLevel = 'STUDENT' | 'PARENT' | 'STAFF' | 'ADMIN' | null;

const MAX_SUBSCRIPTIONS = 200;

/** Mirrors visibleAudiences in @tupo/feed. */
function audiencesFor(level: RoleLevel): string[] {
  switch (level) {
    case 'ADMIN':
    case 'STAFF': return ['everyone', 'staff', 'students', 'parents'];
    case 'STUDENT': return ['everyone', 'students'];
    case 'PARENT': return ['everyone', 'parents'];
    default: return ['everyone'];
  }
}

export function registerFeedHandlers(_io: Server, socket: FeedSocket): void {
  const user = socket.data.user as SessionClaims;
  /** Insertion order is recency: the oldest entry is the first to go. */
  const joined = new Set<string>();
  let levelPromise: Promise<RoleLevel> | null = null;
  const level = () => (levelPromise ??= getPool()
    .query<{ level: RoleLevel }>(
      'SELECT r.level FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = $1', [user.id])
    .then((r) => r.rows[0]?.level ?? null)
    .catch(() => null));

  for (const audience of feedAudiencesForRole(user?.role)) {
    void socket.join(feedAudienceRoom(audience));
  }

  async function visibleIds(ids: string[], kind: 'post' | 'reel'): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const bands = audiencesFor(await level());
    const { rows } = kind === 'reel'
      ? await getPool().query<{ id: string }>(
          `SELECT id FROM feed_reels
            WHERE id = ANY($1::text[]) AND deleted_at IS NULL
              AND (author_id = $2 OR audience = ANY($3::text[]))`,
          [ids, user.id, bands])
      : await getPool().query<{ id: string }>(
          `SELECT fp.id FROM feed_posts fp
             JOIN feed_pages pg ON pg.id = fp.page_id AND pg.deleted_at IS NULL
             LEFT JOIN feed_page_editors e ON e.page_id = fp.page_id AND e.user_id = $2
            WHERE fp.id = ANY($1::text[]) AND fp.deleted_at IS NULL
              AND (e.user_id IS NOT NULL
                   OR (fp.status = 'published' AND fp.audience = ANY($3::text[]) AND pg.audience = ANY($3::text[])))`,
          [ids, user.id, bands]);
    return new Set(rows.map((r) => r.id));
  }

  socket.on('feed:subscribe', async ({ postIds, kind }, ack) => {
    const k = kind === 'reel' ? 'reel' : 'post';
    const room = k === 'reel' ? feedReelRoom : feedPostRoom;
    const wanted = [...new Set(postIds ?? [])].filter(Boolean).slice(-MAX_SUBSCRIPTIONS);
    const allowed = await visibleIds(wanted.filter((id) => !joined.has(`${k}:${id}`)), k);
    for (const id of wanted) {
      const key = `${k}:${id}`;
      if (joined.has(key)) { joined.delete(key); joined.add(key); continue; }   // refresh recency
      if (!allowed.has(id)) continue;
      if (joined.size >= MAX_SUBSCRIPTIONS) {
        const oldest = joined.values().next().value as string;
        joined.delete(oldest);
        const [ok, oid] = oldest.split(':') as ['post' | 'reel', string];
        await socket.leave(ok === 'reel' ? feedReelRoom(oid) : feedPostRoom(oid));
      }
      await socket.join(room(id));
      joined.add(key);
    }
    ack?.({ ok: true, subscribed: [...joined].filter((j) => j.startsWith(`${k}:`)).map((j) => j.slice(k.length + 1)) });
  });

  socket.on('feed:unsubscribe', async ({ postIds, kind }) => {
    const k = kind === 'reel' ? 'reel' : 'post';
    const room = k === 'reel' ? feedReelRoom : feedPostRoom;
    for (const id of postIds ?? []) {
      await socket.leave(room(id));
      joined.delete(`${k}:${id}`);
    }
  });

  socket.on('disconnect', () => { joined.clear(); });
}
