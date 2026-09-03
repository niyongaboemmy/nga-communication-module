/**
 * Reporting and the moderation queue (FR-FEED-8).
 *
 * A report is a row; acting on it removes content, warns, or dismisses, and
 * always leaves a trail. The actual content removal reuses `deletePost` /
 * `deleteComment` with the moderator flag so the same fan-out fires.
 */
import { getPool, snowflake } from '@tupo/db';
import type {
  FeedMediaItem, FeedModerationAction, FeedReportReason, FeedReportView,
} from '@tupo/shared';
import { FEED_REPORT_REASONS } from '@tupo/shared';
import { FeedError } from './errors.js';
import { type FeedActor, can } from './common.js';
import { deletePost } from './posts.js';
import { deleteComment, getCommentPreview } from './comments.js';

export interface ReportInput {
  targetType: 'post' | 'comment';
  targetId: string;
  reason: string;
  note?: string;
}

export async function reportTarget(actor: FeedActor, input: ReportInput): Promise<{ reportId: string }> {
  if (!can(actor, 'REPORT_SUBMIT')) throw new FeedError('You cannot submit reports.', 403);
  const reason: FeedReportReason =
    (FEED_REPORT_REASONS as readonly string[]).includes(input.reason) ? input.reason as FeedReportReason : 'other';

  let postId: string | null = null;
  if (input.targetType === 'post') {
    const { rows } = await getPool().query('SELECT id FROM feed_posts WHERE id = $1 AND deleted_at IS NULL', [input.targetId]);
    if (!rows[0]) throw new FeedError('Post not found.', 404);
    postId = input.targetId;
  } else {
    const { rows } = await getPool().query<{ post_id: string }>(
      'SELECT post_id FROM feed_comments WHERE id = $1 AND deleted_at IS NULL', [input.targetId],
    );
    if (!rows[0]) throw new FeedError('Comment not found.', 404);
    postId = rows[0].post_id;
  }

  const id = snowflake();
  try {
    await getPool().query(
      `INSERT INTO feed_reports (id, target_type, target_id, post_id, reporter_id, reason, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, input.targetType, input.targetId, postId, actor.id, reason, (input.note ?? '').slice(0, 1000)],
    );
  } catch (err) {
    // The partial unique index blocks a second open report from the same person.
    if (err instanceof Error && /feed_reports_one_per_reporter/.test(err.message)) {
      throw new FeedError('You have already reported this. A moderator will review it.', 409);
    }
    throw err;
  }
  return { reportId: id };
}

export async function listQueue(
  actor: FeedActor, opts: { status?: 'open' | 'actioned' | 'dismissed'; limit?: number } = {},
): Promise<FeedReportView[]> {
  if (!can(actor, 'MODERATION_QUEUE_VIEW') && actor.roleLevel !== 'ADMIN') {
    throw new FeedError('You cannot view the moderation queue.', 403);
  }
  const status = opts.status ?? 'open';
  const limit = Math.min(opts.limit ?? 50, 100);
  const { rows } = await getPool().query<{
    id: string; target_type: 'post' | 'comment'; target_id: string; post_id: string | null;
    reason: FeedReportReason; note: string; status: 'open' | 'actioned' | 'dismissed';
    created_at: string; reporter_id: string; reporter_name: string; reporter_avatar: string | null;
  }>(
    `SELECT r.id, r.target_type, r.target_id, r.post_id, r.reason, r.note, r.status, r.created_at,
            r.reporter_id, u.name AS reporter_name, u.avatar_url AS reporter_avatar
       FROM feed_reports r JOIN users u ON u.id = r.reporter_id
      WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT $2`,
    [status, limit],
  );

  const out: FeedReportView[] = [];
  for (const r of rows) {
    let preview: FeedReportView['preview'] = null;
    if (r.target_type === 'post') {
      const { rows: pr } = await getPool().query<{
        body: string; media: FeedMediaItem[]; created_at: string; deleted_at: string | null;
        author_name: string; author_avatar: string | null; page_name: string;
      }>(
        `SELECT p.body, p.media, p.created_at, p.deleted_at, u.name AS author_name,
                u.avatar_url AS author_avatar, pg.name AS page_name
           FROM feed_posts p JOIN users u ON u.id = p.author_id JOIN feed_pages pg ON pg.id = p.page_id
          WHERE p.id = $1`, [r.target_id],
      );
      if (pr[0]) preview = {
        kind: 'post', body: pr[0].body, media: pr[0].media ?? [], createdAt: pr[0].created_at,
        removed: pr[0].deleted_at !== null, pageName: pr[0].page_name,
        author: { id: '', name: pr[0].author_name, avatarUrl: pr[0].author_avatar },
      };
    } else {
      const c = await getCommentPreview(r.target_id);
      if (c) preview = {
        kind: 'comment', body: c.body, media: c.media ?? [], createdAt: c.created_at,
        removed: false,
        author: { id: c.author_id, name: c.author_name, avatarUrl: c.author_avatar },
      };
    }
    out.push({
      id: r.id, targetType: r.target_type, targetId: r.target_id, postId: r.post_id,
      reason: r.reason, note: r.note, status: r.status,
      reporter: { id: r.reporter_id, name: r.reporter_name, avatarUrl: r.reporter_avatar },
      createdAt: r.created_at, preview,
    });
  }
  return out;
}

export interface ActResult {
  targetType: 'post' | 'comment';
  targetId: string;
  postId: string | null;
  parentId: string | null;
  action: FeedModerationAction;
  authorId: string | null;
}

export async function act(
  actor: FeedActor, reportId: string, action: FeedModerationAction, note?: string,
): Promise<ActResult> {
  if (!can(actor, 'MODERATION_ACT') && actor.roleLevel !== 'ADMIN') {
    throw new FeedError('You cannot act on reports.', 403);
  }
  const { rows } = await getPool().query<{
    target_type: 'post' | 'comment'; target_id: string; post_id: string | null; status: string;
  }>('SELECT target_type, target_id, post_id, status FROM feed_reports WHERE id = $1', [reportId]);
  const report = rows[0];
  if (!report) throw new FeedError('Report not found.', 404);

  let authorId: string | null = null;
  let parentId: string | null = null;

  if (action === 'remove') {
    if (report.target_type === 'post') {
      const { rows: a } = await getPool().query<{ author_id: string }>('SELECT author_id FROM feed_posts WHERE id = $1', [report.target_id]);
      authorId = a[0]?.author_id ?? null;
      await deletePost(actor, report.target_id, true).catch((e) => { if (!(e instanceof FeedError && e.status === 404)) throw e; });
    } else {
      const { rows: a } = await getPool().query<{ author_id: string; parent_id: string | null }>('SELECT author_id, parent_id FROM feed_comments WHERE id = $1', [report.target_id]);
      authorId = a[0]?.author_id ?? null;
      parentId = a[0]?.parent_id ?? null;
      await deleteComment(actor, report.target_id, true).catch((e) => { if (!(e instanceof FeedError && e.status === 404)) throw e; });
    }
  }

  const resolution = action === 'remove' ? 'removed' : action === 'warn' ? 'warned' : 'dismissed';
  const status = action === 'dismiss' ? 'dismissed' : 'actioned';
  await getPool().query(
    `UPDATE feed_reports SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now(),
        note = CASE WHEN $5::text <> '' THEN note || E'\\n— ' || $5 ELSE note END
      WHERE (id = $1 OR (target_type = $6 AND target_id = $7)) AND status = 'open'`,
    [reportId, status, resolution, actor.id, (note ?? '').slice(0, 1000), report.target_type, report.target_id],
  );

  return { targetType: report.target_type, targetId: report.target_id, postId: report.post_id, parentId, action, authorId };
}
