/**
 * Poll voting (FR-FEED-2). Single- or multi-select; re-voting replaces the
 * previous choice set. Closed polls (past `closesAt`) refuse new votes but
 * still return tallies.
 */
import { getPool } from '@tupo/db';
import type { FeedPollView } from '@tupo/shared';
import { FeedError } from './errors.js';
import type { FeedActor } from './common.js';

export interface PollVoteResult { postId: string; poll: FeedPollView; }

export async function votePoll(actor: FeedActor, postId: string, choices: number[]): Promise<PollVoteResult> {
  const { rows } = await getPool().query<{
    poll: { question: string; options: string[]; multi: boolean; closesAt: string | null } | null;
    status: string;
  }>(`SELECT poll, status FROM feed_posts WHERE id = $1 AND deleted_at IS NULL`, [postId]);
  const row = rows[0];
  if (!row || !row.poll || row.status !== 'published') throw new FeedError('Poll not found.', 404);
  if (row.poll.closesAt && Date.parse(row.poll.closesAt) <= Date.now()) {
    throw new FeedError('This poll has closed.', 409);
  }

  const valid = [...new Set(choices)].filter((i) => Number.isInteger(i) && i >= 0 && i < row.poll!.options.length);
  if (!valid.length) throw new FeedError('Choose an option.', 400);
  const picks = row.poll.multi ? valid : [valid[0]!];

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM feed_poll_votes WHERE post_id = $1 AND user_id = $2', [postId, actor.id]);
    for (const i of picks) {
      await client.query(
        `INSERT INTO feed_poll_votes (post_id, user_id, option_index) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [postId, actor.id, i],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { postId, poll: await pollView(actor, postId) };
}

export async function pollView(actor: FeedActor, postId: string): Promise<FeedPollView> {
  const { rows } = await getPool().query<{
    poll: { question: string; options: string[]; multi: boolean; closesAt: string | null } | null;
  }>('SELECT poll FROM feed_posts WHERE id = $1', [postId]);
  const poll = rows[0]?.poll;
  if (!poll) throw new FeedError('Poll not found.', 404);

  const { rows: tallies } = await getPool().query<{ option_index: number; n: string }>(
    'SELECT option_index, count(*)::text AS n FROM feed_poll_votes WHERE post_id = $1 GROUP BY option_index', [postId],
  );
  const { rows: voters } = await getPool().query<{ n: string }>(
    'SELECT count(DISTINCT user_id)::text AS n FROM feed_poll_votes WHERE post_id = $1', [postId],
  );
  const { rows: mine } = await getPool().query<{ option_index: number }>(
    'SELECT option_index FROM feed_poll_votes WHERE post_id = $1 AND user_id = $2', [postId, actor.id],
  );
  const tallyMap = new Map(tallies.map((t) => [t.option_index, Number(t.n)]));
  return {
    question: poll.question,
    options: poll.options.map((text, i) => ({ text, votes: tallyMap.get(i) ?? 0 })),
    multi: poll.multi,
    closesAt: poll.closesAt,
    closed: Boolean(poll.closesAt && Date.parse(poll.closesAt) <= Date.now()),
    totalVoters: Number(voters[0]?.n ?? 0),
    myVotes: mine.map((m) => m.option_index),
  };
}
