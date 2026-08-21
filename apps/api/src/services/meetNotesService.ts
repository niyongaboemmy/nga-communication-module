import { getPool, snowflake } from '@tupo/db';
import type { MeetNote, NoteSource } from '@tupo/shared';
import { generatePlainText } from './aiProviders/index.js';

/**
 * Personal notes.
 *
 * The distinction from `meeting_ai_artifacts` is the whole point of this file:
 * an artifact is something a model produced and can regenerate, a note is
 * something a person decided to keep. They are never allowed to overwrite each
 * other. The AI can *help* with a note — tidy it up, or hand you a summary to
 * keep — but the person owns the result, and the pre-AI text is always
 * retained so "tidy this up" can be undone.
 */

interface NoteRow {
  id: string;
  meeting_id: string;
  participant_id: string;
  author_name: string;
  body: string;
  source: NoteSource;
  original_body: string | null;
  provider_used: string | null;
  offset_seconds: number | null;
  is_shared: boolean;
  pinned: boolean;
  created_at: Date;
  updated_at: Date;
}

const toWire = (r: NoteRow, viewerParticipantId?: string): MeetNote => ({
  id: r.id,
  meetingId: r.meeting_id,
  participantId: r.participant_id,
  authorName: r.author_name,
  body: r.body,
  source: r.source,
  originalBody: r.original_body,
  providerUsed: r.provider_used,
  offsetSeconds: r.offset_seconds,
  isShared: r.is_shared,
  pinned: r.pinned,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  isMine: viewerParticipantId ? r.participant_id === viewerParticipantId : undefined,
});

/** Seconds since the meeting started, so a note lines up with the transcript. */
export async function meetingOffset(meetingId: string): Promise<number | null> {
  const { rows } = await getPool().query<{ started_at: Date | null }>(
    'SELECT started_at FROM meetings WHERE id = $1', [meetingId],
  );
  const startedAt = rows[0]?.started_at;
  if (!startedAt) return null;
  return Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000));
}

/**
 * Everything this participant may see: their own notes, plus any note anyone
 * chose to share. A private note never leaves its author, and the filtering
 * happens in SQL rather than in the client for exactly that reason.
 */
export async function listNotes(
  meetingId: string, participantId: string,
): Promise<MeetNote[]> {
  const { rows } = await getPool().query<NoteRow>(
    `SELECT * FROM meeting_notes
      WHERE meeting_id = $1 AND deleted_at IS NULL
        AND (participant_id = $2 OR is_shared = true)
      ORDER BY pinned DESC, created_at`,
    [meetingId, participantId],
  );
  return rows.map((r) => toWire(r, participantId));
}

export async function createNote(p: {
  meetingId: string;
  participantId: string;
  userId: string | null;
  authorName: string;
  body: string;
  source: NoteSource;
  isShared: boolean;
  pinned?: boolean;
  originalBody?: string | null;
  providerUsed?: string | null;
}): Promise<MeetNote> {
  const id = snowflake();
  const { rows } = await getPool().query<NoteRow>(
    `INSERT INTO meeting_notes
       (id, meeting_id, participant_id, user_id, author_name, body, source,
        original_body, provider_used, offset_seconds, is_shared, pinned)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      id, p.meetingId, p.participantId,
      // A guest has no users row, so this stays null and the participant row is
      // the only author of record.
      p.userId && !p.userId.startsWith('guest:') ? p.userId : null,
      p.authorName, p.body, p.source,
      p.originalBody ?? null, p.providerUsed ?? null,
      await meetingOffset(p.meetingId),
      p.isShared, p.pinned ?? false,
    ],
  );
  return toWire(rows[0]!, p.participantId);
}

/** Only the author may change a note. Enforced in the WHERE clause. */
export async function updateNote(
  noteId: string, participantId: string,
  patch: { body?: string; isShared?: boolean; pinned?: boolean },
): Promise<MeetNote | null> {
  const { rows } = await getPool().query<NoteRow>(
    `UPDATE meeting_notes SET
       body      = COALESCE($3, body),
       is_shared = COALESCE($4, is_shared),
       pinned    = COALESCE($5, pinned),
       updated_at = now()
     WHERE id = $1 AND participant_id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [noteId, participantId, patch.body ?? null,
      patch.isShared ?? null, patch.pinned ?? null],
  );
  return rows[0] ? toWire(rows[0], participantId) : null;
}

/** Soft delete — a shared note others have read should not vanish from history. */
export async function deleteNote(noteId: string, participantId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE meeting_notes SET deleted_at = now(), is_shared = false
      WHERE id = $1 AND participant_id = $2 AND deleted_at IS NULL`,
    [noteId, participantId],
  );
  return !!rowCount;
}

/**
 * One-tap capture of what was just said.
 *
 * This is the feature that makes manual note-taking survive a live meeting: the
 * moment worth writing down has usually just passed, and by the time you have
 * typed it you have missed the next one. Pressing capture reaches back over the
 * transcript instead.
 */
export async function captureFromTranscript(
  meetingId: string, seconds: number,
): Promise<{ body: string; lineCount: number }> {
  const offset = await meetingOffset(meetingId);
  const { rows } = await getPool().query<{
    speaker_name: string; text: string; offset_seconds: number | null;
  }>(
    `SELECT speaker_name, text, offset_seconds
       FROM meeting_transcript_segments
      WHERE meeting_id = $1 AND is_final = true
        AND ($2::int IS NULL OR offset_seconds IS NULL OR offset_seconds >= $2)
      ORDER BY started_at DESC
      LIMIT 40`,
    [meetingId, offset === null ? null : Math.max(0, offset - seconds)],
  );

  // Read back in the order it was said, not the order the query returned it.
  const lines = rows.reverse();
  return {
    body: lines.map((l) => `${l.speaker_name}: ${l.text}`).join('\n'),
    lineCount: lines.length,
  };
}

/**
 * Clean up a note someone typed in a hurry.
 *
 * Explicitly *not* a rewrite: the instruction is to keep the author's meaning
 * and their facts, because a note that says something the author did not mean
 * is worse than a scruffy one. The original is preserved on the row either way.
 */
export async function tidyNote(
  body: string, context: { title: string; recentTranscript?: string },
): Promise<{ body: string; providerUsed: string }> {
  const { data, providerUsed } = await generatePlainText(
    'You are tidying up a note someone typed quickly during a school meeting.\n\n' +
    'Rules:\n' +
    '- Keep the author\'s meaning and every fact they wrote. Add nothing.\n' +
    '- Fix spelling, punctuation and half-finished words. Expand obvious ' +
    'abbreviations only where you are certain.\n' +
    '- Keep it about the same length. Do not turn three words into a paragraph.\n' +
    '- Keep any list as a list.\n' +
    '- Reply with the tidied note alone: no preamble, no quotation marks, no ' +
    'commentary.\n\n' +
    `Meeting: ${context.title}\n` +
    (context.recentTranscript
      ? `\nWhat was being discussed, for spelling of names and terms only:\n${context.recentTranscript}\n`
      : '') +
    `\nThe note:\n${body}`,
    Math.max(300, Math.ceil(body.length / 2)),
  );
  return { body: data.trim(), providerUsed };
}

/** The notes that belong in the meeting's written record. */
export async function notesForSummary(meetingId: string): Promise<MeetNote[]> {
  const { rows } = await getPool().query<NoteRow>(
    `SELECT * FROM meeting_notes
      WHERE meeting_id = $1 AND deleted_at IS NULL AND is_shared = true
      ORDER BY pinned DESC, created_at`,
    [meetingId],
  );
  return rows.map((r) => toWire(r));
}
