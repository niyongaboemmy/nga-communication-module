import { getPool, snowflake } from '@tupo/db';
import type { PoolClient } from 'pg';
import type { ConversationSummary, MemberRole, SubjectSummary } from '@tupo/shared';
import { ChatError, getConversation } from './service.js';

/**
 * Subject channels (the Channels page).
 *
 * A subject's channels belong to everyone who teaches or takes the subject:
 * membership is derived from user_subjects, which is replaced from the MIS at
 * each sign-in (see syncUserSubjects). Every subject gets a #general; its
 * teachers (and admins) can add more. Teachers join as channel admins, students
 * as members, so the chat engine's own moderation rules apply unchanged.
 */

const SUBJECT_SPACE = 'subjects';

export interface MisSubject {
  id: string;
  name: string;
  code: string | null;
  role: 'teacher' | 'student';
}

const memberRoleFor = (role: 'teacher' | 'student'): MemberRole => (role === 'teacher' ? 'admin' : 'member');

const slugFor = (subjectId: string, name: string) =>
  `s${subjectId}-${name.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 50) || 'channel'}`;

async function refreshMemberCount(client: PoolClient, conversationId: string) {
  await client.query(
    `UPDATE conversations SET member_count = (
       SELECT count(*) FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL)
     WHERE id = $1`,
    [conversationId],
  );
}

/** Add someone to a channel, or bring them back; their role follows their part in the subject. */
async function upsertMember(client: PoolClient, conversationId: string, userId: string, role: MemberRole) {
  await client.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role)
     VALUES ($1,$2,$3)
     ON CONFLICT (conversation_id, user_id)
     DO UPDATE SET left_at = NULL, is_hidden = false,
                   role = CASE WHEN conversation_members.role = 'owner' THEN 'owner' ELSE EXCLUDED.role END
     WHERE conversation_members.left_at IS NOT NULL OR conversation_members.role <> EXCLUDED.role`,
    [conversationId, userId, role],
  );
}

/** Every subject has a #general; create it the first time anyone from the subject signs in. */
async function ensureGeneral(client: PoolClient, subjectId: string, createdBy: string): Promise<void> {
  const { rows } = await client.query(
    `SELECT 1 FROM conversations WHERE subject_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [subjectId, slugFor(subjectId, 'general')],
  );
  if (rows.length) return;
  await client.query(
    `INSERT INTO conversations (id, space_id, type, slug, name, topic, is_private, created_by, member_count, subject_id, origin)
     VALUES ($1, $2, 'channel', $3, 'general', 'Everything about this subject', false, $4, 0, $5, 'subject')
     ON CONFLICT DO NOTHING`,
    [snowflake(), SUBJECT_SPACE, slugFor(subjectId, 'general'), createdBy, subjectId],
  );
}

/**
 * Replace a person's subjects with what the MIS says now, and bring their
 * channel membership into line: in every channel of their subjects, out of the
 * channels of subjects they no longer have. One transaction, so a half-synced
 * person never exists.
 */
export async function syncUserSubjects(userId: string, subjects: MisSubject[]): Promise<void> {
  // A subject someone both teaches and takes counts as teaching.
  const byId = new Map<string, MisSubject>();
  for (const s of subjects) {
    const prev = byId.get(s.id);
    if (!prev || s.role === 'teacher') byId.set(s.id, s);
  }
  const list = [...byId.values()];

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const s of list) {
      await client.query(
        `INSERT INTO subjects (id, name, code) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, code = EXCLUDED.code, updated_at = now()`,
        [s.id, s.name, s.code],
      );
      await client.query(
        `INSERT INTO user_subjects (user_id, subject_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, subject_id) DO UPDATE SET role = EXCLUDED.role, synced_at = now()`,
        [userId, s.id, s.role],
      );
      await ensureGeneral(client, s.id, userId);
    }
    const ids = list.map((s) => s.id);
    await client.query(
      'DELETE FROM user_subjects WHERE user_id = $1 AND NOT (subject_id = ANY($2::text[]))', [userId, ids],
    );

    // Into every channel of their subjects.
    const { rows: channels } = await client.query<{ id: string; subject_id: string }>(
      `SELECT id, subject_id FROM conversations
        WHERE subject_id = ANY($1::text[]) AND deleted_at IS NULL AND is_archived = false`,
      [ids],
    );
    for (const c of channels) {
      await upsertMember(client, c.id, userId, memberRoleFor(byId.get(c.subject_id)!.role));
      await refreshMemberCount(client, c.id);
    }

    // Out of channels of subjects they no longer have.
    const { rows: stale } = await client.query<{ id: string }>(
      `UPDATE conversation_members m SET left_at = now()
         FROM conversations c
        WHERE m.conversation_id = c.id AND m.user_id = $1 AND m.left_at IS NULL
          AND c.subject_id IS NOT NULL AND NOT (c.subject_id = ANY($2::text[]))
       RETURNING c.id`,
      [userId, ids],
    );
    for (const c of stale) await refreshMemberCount(client, c.id);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The subjects someone teaches or takes, A-Z. */
export async function listMySubjects(userId: string, isAdmin: boolean): Promise<SubjectSummary[]> {
  const { rows } = await getPool().query<{ id: string; name: string; code: string | null; role: 'teacher' | 'student' }>(
    `SELECT s.id, s.name, s.code, us.role
       FROM user_subjects us JOIN subjects s ON s.id = us.subject_id
      WHERE us.user_id = $1
      ORDER BY s.name`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, code: r.code, myRole: r.role,
    canCreateChannels: r.role === 'teacher' || isAdmin,
  }));
}

/**
 * A new channel in a subject, for its teachers (or an admin). Everyone in the
 * subject is in it straight away; the creator owns it.
 */
export async function createSubjectChannel(
  actorId: string, isAdmin: boolean, subjectId: string,
  input: { name: string; topic?: string | null },
): Promise<ConversationSummary> {
  const name = (input.name ?? '').trim().replace(/^#/, '').slice(0, 60);
  if (!name) throw new ChatError('Give the channel a name.', 400);

  const pool = getPool();
  const { rows: mine } = await pool.query<{ role: string }>(
    'SELECT role FROM user_subjects WHERE user_id = $1 AND subject_id = $2', [actorId, subjectId],
  );
  if (mine[0]?.role !== 'teacher' && !isAdmin) {
    throw new ChatError('Only teachers of this subject can add channels to it.', 403);
  }
  const { rows: subj } = await pool.query('SELECT 1 FROM subjects WHERE id = $1', [subjectId]);
  if (!subj.length) throw new ChatError('Subject not found.', 404);

  const slug = slugFor(subjectId, name);
  const id = snowflake();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: clash } = await client.query(
      'SELECT 1 FROM conversations WHERE space_id = $1 AND lower(slug) = lower($2) AND deleted_at IS NULL',
      [SUBJECT_SPACE, slug],
    );
    if (clash.length) throw new ChatError('This subject already has a channel with that name.', 409);

    await client.query(
      `INSERT INTO conversations (id, space_id, type, slug, name, topic, is_private, created_by, member_count, subject_id, origin)
       VALUES ($1, $2, 'channel', $3, $4, $5, false, $6, 0, $7, 'subject')`,
      [id, SUBJECT_SPACE, slug, name.toLowerCase().replace(/\s+/g, '-'), input.topic?.trim() || null, actorId, subjectId],
    );
    const { rows: people } = await client.query<{ user_id: string; role: 'teacher' | 'student' }>(
      'SELECT user_id, role FROM user_subjects WHERE subject_id = $1', [subjectId],
    );
    for (const p of people) await upsertMember(client, id, p.user_id, memberRoleFor(p.role));
    await upsertMember(client, id, actorId, 'owner');
    await client.query(
      `UPDATE conversation_members SET role = 'owner' WHERE conversation_id = $1 AND user_id = $2`, [id, actorId],
    );
    await refreshMemberCount(client, id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getConversation(actorId, id);
}
