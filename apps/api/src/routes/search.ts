import { Router, type Request, type Response } from 'express';
import { getPool } from '@tupo/db';
import * as chat from '@tupo/chat';
import { pages as feedPages, visibleAudiences, type FeedActor } from '@tupo/feed';
import { ok, fail } from '@tupo/shared';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { hasPermission } from '../access/gate.js';
import { contactDenied } from '../access/contactGate.js';

/**
 * One search box for the whole product.
 *
 * Two rules shape everything here.
 *
 * **Every section is scoped by the same rule its own module enforces**, and the
 * scope is a join wherever it can be — rows come out of the membership /
 * recipient / audience table, so there is no ordering of clauses in which
 * something the viewer cannot open appears in their results. A search box is
 * the easiest place in a product to leak the existence of things: the title of
 * a private channel, the subject line of somebody else's mail, the name of a
 * pupil in a meeting you were not in. Absent, not greyed out.
 *
 * **One slow or broken section must not cost the others.** The sections run
 * concurrently and are settled independently: if mail throws, the palette still
 * shows messages and people rather than a 500.
 *
 * Permissions are checked per section rather than on the route, because the
 * sections have different gates. In the default role set almost everything
 * here is baseline, so this matters mainly when an administrator has built a
 * custom role with a key removed — but that is exactly when it must hold.
 */

const router = Router();
router.use(authMiddleware);

const actor = (req: Request) => (req as AuthenticatedRequest).user!;
// In shadow mode each check is also compared with the v2 snapshot; in enforce
// `permissions` already is the v2 set (see access/gate.ts).
const can = (req: Request, key: string) => hasPermission(req, key);
const feedActorOf = (req: Request): FeedActor => {
  const u = actor(req);
  return { id: u.id, roleLevel: u.roleLevel, permissions: u.permissions };
};

/** Shared with the chat search so one client-side component highlights every kind. */
const { HIGHLIGHT_START, HIGHLIGHT_END } = chat;

/** Wraps each occurrence of the term, for sections matched with ILIKE rather
 *  than ts_headline. Case-insensitive, and the needle is treated as a literal. */
function markMatches(text: string, term: string): string {
  if (!text || !term) return text ?? '';
  const needle = term.trim();
  if (!needle) return text;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), (m) => `${HIGHLIGHT_START}${m}${HIGHLIGHT_END}`);
}

/** A single line in the palette. `href` is where Enter takes you. */
export interface SearchResult {
  id: string;
  /** Section this belongs to; the client groups and labels by it. */
  type: 'message' | 'conversation' | 'channel' | 'person' | 'mail' | 'post' | 'page' | 'meeting' | 'file';
  title: string;
  /** Highlighted where the section can produce one; plain otherwise. */
  subtitle?: string;
  meta?: string;
  href: string;
  avatarName?: string;
  avatarUrl?: string | null;
  at?: string | null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const snippet = (s: string | null | undefined, n = 160) =>
  !s ? '' : (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/* ────────────────────────────────────────────────────────────────────────── *
 * Sections
 * ────────────────────────────────────────────────────────────────────────── */

/** Chat messages. Delegates to the module's own search, which is already an
 *  FTS query joined through conversation_members. */
async function searchMessagesSection(req: Request, q: string, limit: number): Promise<SearchResult[]> {
  if (!can(req, 'MESSAGE_READ')) return [];
  const { hits } = await chat.searchMessages(actor(req).id, q, { limit });
  return hits.map((h) => ({
    id: `message:${h.message.id}`,
    type: 'message' as const,
    title: h.conversationName,
    subtitle: h.highlight,
    meta: h.message.senderName ?? undefined,
    href: `/app/chat?c=${encodeURIComponent(h.conversationId)}&m=${encodeURIComponent(h.message.id)}`,
    avatarName: h.message.senderName ?? h.conversationName,
    at: h.message.createdAt,
  }));
}

/** Conversations the viewer is actually in — matched on name and topic. A DM
 *  has no name of its own, so it is matched on the other person's name. */
async function searchConversationsSection(req: Request, q: string, limit: number): Promise<SearchResult[]> {
  if (!can(req, 'CHANNEL_VIEW')) return [];
  const { rows } = await getPool().query<{
    id: string; name: string | null; topic: string | null; type: string;
    member_count: number; peer_name: string | null; last_message_at: string | null;
  }>(
    `SELECT c.id, c.name, c.topic, c.type, c.member_count, c.last_message_at,
            peer.name AS peer_name
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id AND c.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT u.name FROM conversation_members pm
           JOIN users u ON u.id = pm.user_id
          WHERE pm.conversation_id = c.id AND pm.user_id <> cm.user_id AND pm.left_at IS NULL
          LIMIT 1
       ) peer ON c.type = 'dm'
      WHERE cm.user_id = $1 AND cm.left_at IS NULL
        AND (c.name ILIKE '%' || $2 || '%'
             OR coalesce(c.topic, '') ILIKE '%' || $2 || '%'
             OR (c.type = 'dm' AND peer.name ILIKE '%' || $2 || '%'))
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $3`,
    [actor(req).id, q, limit],
  );
  return rows.map((r) => {
    const name = r.type === 'dm' ? (r.peer_name ?? 'Direct message') : (r.name ?? 'Untitled');
    return {
      id: `conversation:${r.id}`,
      type: 'conversation' as const,
      title: markMatches(name, q),
      subtitle: r.topic ? markMatches(snippet(r.topic), q) : undefined,
      meta: r.type === 'dm' ? 'Direct message' : `${r.member_count} members`,
      href: `/app/chat?c=${encodeURIComponent(r.id)}`,
      avatarName: name,
      at: r.last_message_at,
    };
  });
}

/** Public channels the viewer could join but is not in. Private ones are
 *  absent — naming one discloses it exists. */
async function searchChannelsSection(req: Request, q: string, limit: number): Promise<SearchResult[]> {
  if (!can(req, 'CHANNEL_VIEW')) return [];
  const found = await chat.discoverChannels(actor(req).id, { query: q, limit: limit * 2 });
  return found
    .filter((c) => !c.isMember)
    .slice(0, limit)
    .map((c) => ({
      id: `channel:${c.id}`,
      type: 'channel' as const,
      title: markMatches(c.name ?? 'Untitled', q),
      subtitle: c.topic ? markMatches(snippet(c.topic), q) : undefined,
      meta: `${c.memberCount} members · not joined`,
      href: `/app/chat?browse=${encodeURIComponent(c.id)}`,
      avatarName: c.name ?? '#',
    }));
}

/** People. Same rule as the chat directory: active accounts only, never
 *  yourself, and never across a block in either direction. */
async function searchPeopleSection(req: Request, q: string, limit: number): Promise<SearchResult[]> {
  if (!can(req, 'DIRECTORY_VIEW')) return [];
  const { rows } = await getPool().query<{
    id: string; name: string; email: string; avatar_url: string | null;
    role: string | null; title: string | null;
  }>(
    `SELECT id, name, email, avatar_url, role, title
       FROM users
      WHERE id <> $1 AND status = 'active'
        AND (name ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%')
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = users.id AND b.blocked_id = $1)
              OR (b.blocker_id = $1 AND b.blocked_id = users.id))
      ORDER BY name ASC
      LIMIT $3`,
    [actor(req).id, q, limit],
  );
  // Contact policy (v2): only people the viewer may contact are findable.
  const hidden = await contactDenied(actor(req), rows.map((r) => r.id), 'directory');
  return rows.filter((r) => !hidden.has(r.id)).map((r) => ({
    id: `person:${r.id}`,
    type: 'person' as const,
    title: markMatches(r.name, q),
    subtitle: markMatches(r.email, q),
    meta: r.title ?? r.role ?? undefined,
    href: `/app/chat?dm=${encodeURIComponent(r.id)}`,
    avatarName: r.name,
    avatarUrl: r.avatar_url,
  }));
}

/**
 * Mail the viewer is party to.
 *
 * Scoped exactly as the mailbox is: they sent it, or they are a recipient whose
 * copy still exists. Someone else's draft is never matched, and a thread the
 * viewer only appears in as BCC on somebody else's copy is not theirs to find.
 * Unlike the folder-scoped mailbox search, this looks at message bodies too —
 * which is what the mail FTS index was built for and never used by.
 */
async function searchMailSection(req: Request, q: string, limit: number): Promise<SearchResult[]> {
  if (!can(req, 'MAIL_READ')) return [];
  const { rows } = await getPool().query<{
    thread_id: string; subject: string; last_snippet: string;
    last_message_at: string; last_sender_name: string | null;
  }>(
    `SELECT t.id AS thread_id, t.subject, t.last_snippet, t.last_message_at, t.last_sender_name
       FROM mail_threads t
      WHERE (
              EXISTS (SELECT 1 FROM mail_recipients r
                       WHERE r.thread_id = t.id AND r.user_id = $1
                         AND NOT r.is_hidden AND r.folder <> 'trash')
           OR EXISTS (SELECT 1 FROM mail_messages sm
                       WHERE sm.thread_id = t.id AND sm.from_user_id = $1)
            )
        AND (
              t.subject ILIKE '%' || $2 || '%'
           OR t.last_snippet ILIKE '%' || $2 || '%'
           OR EXISTS (
                SELECT 1 FROM mail_messages m
                 WHERE m.thread_id = t.id
                   -- A draft belongs to whoever is writing it, and to nobody else.
                   AND (NOT m.is_draft OR m.from_user_id = $1)
                   AND to_tsvector('simple',
                         coalesce(m.subject, '') || ' ' || coalesce(m.body_text, ''))
                       @@ websearch_to_tsquery('simple', $3))
            )
      ORDER BY t.last_message_at DESC
      LIMIT $4`,
    [actor(req).id, q, q, limit],
  );
  return rows.map((r) => ({
    id: `mail:${r.thread_id}`,
    type: 'mail' as const,
    title: markMatches(r.subject, q),
    subtitle: markMatches(snippet(r.last_snippet), q),
    meta: r.last_sender_name ?? undefined,
    href: `/app/mail/t/${encodeURIComponent(r.thread_id)}`,
    avatarName: r.last_sender_name ?? r.subject,
    at: r.last_message_at,
  }));
}

/**
 * Feed posts, by the audience rule alone.
 *
 * Deliberately *not* scoped to the follow graph the timeline uses: the timeline
 * answers "what should I be shown", search answers "where is the thing I
 * remember reading", and those are different questions. Everything published to
 * a band this role can see is findable.
 */
async function searchPostsSection(req: Request, q: string, limit: number): Promise<SearchResult[]> {
  if (!can(req, 'FEED_VIEW')) return [];
  const audiences = visibleAudiences(feedActorOf(req).roleLevel);
  const { rows } = await getPool().query<{
    id: string; body: string; published_at: string | null;
    page_name: string; page_slug: string;
  }>(
    `SELECT p.id, p.body, p.published_at, pg.name AS page_name, pg.slug AS page_slug
       FROM feed_posts p
       JOIN feed_pages pg ON pg.id = p.page_id AND pg.deleted_at IS NULL
      WHERE p.deleted_at IS NULL
        AND p.status = 'published'
        AND p.audience = ANY($1)
        AND to_tsvector('english', coalesce(p.body, '')) @@ websearch_to_tsquery('english', $2)
      ORDER BY p.published_at DESC NULLS LAST
      LIMIT $3`,
    [audiences, q, limit],
  );
  return rows.map((r) => ({
    id: `post:${r.id}`,
    type: 'post' as const,
    title: r.page_name,
    subtitle: markMatches(snippet(r.body), q),
    meta: 'Feed post',
    href: `/app/feed/post/${encodeURIComponent(r.id)}`,
    avatarName: r.page_name,
    at: r.published_at,
  }));
}

/** Feed pages, through the module's own audience-or-editor rule. */
async function searchPagesSection(req: Request, q: string, limit: number): Promise<SearchResult[]> {
  if (!can(req, 'FEED_VIEW')) return [];
  const found = await feedPages.listPages(feedActorOf(req), { q });
  return found.slice(0, limit).map((p) => ({
    id: `page:${p.id}`,
    type: 'page' as const,
    title: markMatches(p.name, q),
    subtitle: p.bio ? snippet(p.bio) : undefined,
    meta: `${p.followerCount} followers`,
    href: `/app/feed/p/${encodeURIComponent(p.slug)}`,
    avatarName: p.name,
  }));
}

/** Meetings the viewer hosted, was invited to, or attended. */
async function searchMeetingsSection(req: Request, q: string, limit: number): Promise<SearchResult[]> {
  if (!can(req, 'MEET_JOIN')) return [];
  const { rows } = await getPool().query<{
    id: string; title: string; description: string | null; join_code: string;
    status: string; scheduled_start: string | null; started_at: string | null;
  }>(
    `SELECT m.id, m.title, m.description, m.join_code, m.status, m.scheduled_start, m.started_at
       FROM meetings m
      WHERE (
              m.host_id = $1
           OR EXISTS (SELECT 1 FROM meeting_invites i WHERE i.meeting_id = m.id AND i.user_id = $1)
           OR EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id = m.id AND p.user_id = $1)
            )
        AND (m.title ILIKE '%' || $2 || '%'
             OR coalesce(m.description, '') ILIKE '%' || $2 || '%'
             OR m.join_code ILIKE '%' || $2 || '%')
      ORDER BY coalesce(m.scheduled_start, m.started_at, m.created_at) DESC
      LIMIT $3`,
    [actor(req).id, q, limit],
  );
  return rows.map((r) => ({
    id: `meeting:${r.id}`,
    type: 'meeting' as const,
    title: markMatches(r.title, q),
    subtitle: r.description ? markMatches(snippet(r.description), q) : undefined,
    meta: r.status === 'live' ? 'Live now' : r.status,
    href: r.status === 'ended'
      ? `/app/meet/${encodeURIComponent(r.id)}/summary`
      : `/app/meet/${encodeURIComponent(r.id)}`,
    avatarName: r.title,
    at: r.scheduled_start ?? r.started_at,
  }));
}

/**
 * Files, by name.
 *
 * Two grants only: the viewer's own uploads, and attachments on a message in a
 * conversation they are still in — the same join the files service uses, with
 * the same `left_at IS NULL` and deleted-message conditions. The mail and feed
 * grants that service also honours are left out here rather than reimplemented
 * approximately; a file found through the wrong rule is a disclosure, and those
 * files are reachable through their own sections anyway.
 */
async function searchFilesSection(req: Request, q: string, limit: number): Promise<SearchResult[]> {
  if (!can(req, 'FILE_DOWNLOAD')) return [];
  const { rows } = await getPool().query<{
    id: string; original_name: string; mime_type: string; size_bytes: string;
    created_at: string; conversation_id: string | null; conversation_name: string | null;
  }>(
    `SELECT DISTINCT ON (f.id)
            f.id, f.original_name, f.mime_type, f.size_bytes, f.created_at,
            ma.conversation_id, c.name AS conversation_name
       FROM files f
       LEFT JOIN message_attachments ma ON ma.file_id = f.id
       LEFT JOIN messages msg ON msg.id = ma.message_id
                             AND msg.conversation_id = ma.conversation_id
                             AND msg.deleted_at IS NULL
       LEFT JOIN conversations c ON c.id = ma.conversation_id AND c.deleted_at IS NULL
      WHERE f.deleted_at IS NULL
        AND f.status = 'ready'
        AND f.original_name ILIKE '%' || $2 || '%'
        AND (
              f.owner_id = $1
           OR (msg.id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM conversation_members cm
                  WHERE cm.conversation_id = ma.conversation_id
                    AND cm.user_id = $1 AND cm.left_at IS NULL))
            )
      ORDER BY f.id, f.created_at DESC
      LIMIT $3`,
    [actor(req).id, q, limit],
  );
  return rows.map((r) => ({
    id: `file:${r.id}`,
    type: 'file' as const,
    title: markMatches(r.original_name, q),
    subtitle: r.conversation_name ?? undefined,
    meta: r.mime_type,
    href: r.conversation_id
      ? `/app/chat?c=${encodeURIComponent(r.conversation_id)}`
      : '/app/files',
    avatarName: r.original_name,
    at: r.created_at,
  }));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Route
 * ────────────────────────────────────────────────────────────────────────── */

type SectionKey = SearchResult['type'];

const SECTIONS: Record<SectionKey, (req: Request, q: string, limit: number) => Promise<SearchResult[]>> = {
  message: searchMessagesSection,
  conversation: searchConversationsSection,
  channel: searchChannelsSection,
  person: searchPeopleSection,
  mail: searchMailSection,
  post: searchPostsSection,
  page: searchPagesSection,
  meeting: searchMeetingsSection,
  file: searchFilesSection,
};

/**
 * GET /api/search?q=&types=message,person&limit=5
 *
 * `types` narrows to particular sections (the palette's filter chips); omitted
 * means everything this person is allowed to see.
 */
router.get('/', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim().slice(0, 120);
  // Two characters is where a substring search stops being a search and starts
  // being "return the table".
  if (q.length < 2) return res.json(ok({ query: q, results: {}, tookMs: 0 }));

  const limit = clamp(parseInt(String(req.query.limit ?? '5'), 10) || 5, 1, 25);
  const requested = String(req.query.types ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const keys = (requested.length
    ? requested.filter((t): t is SectionKey => t in SECTIONS)
    : (Object.keys(SECTIONS) as SectionKey[]));

  const started = Date.now();
  const settled = await Promise.allSettled(
    keys.map(async (key) => [key, await SECTIONS[key](req, q, limit)] as const),
  );

  const results: Partial<Record<SectionKey, SearchResult[]>> = {};
  const failedSections: SectionKey[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      const [key, rows] = outcome.value;
      if (rows.length) results[key] = rows;
    } else {
      // Degrade, do not fail: one broken section must not empty the palette.
      failedSections.push(keys[i]!);
    }
  });

  res.json(ok({
    query: q,
    results,
    total: Object.values(results).reduce((n, rows) => n + (rows?.length ?? 0), 0),
    ...(failedSections.length ? { failedSections } : {}),
    tookMs: Date.now() - started,
  }));
});

export default router;
