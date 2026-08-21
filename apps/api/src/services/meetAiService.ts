import { getPool, snowflake } from '@tupo/db';
import type {
  MeetActionItem, MeetAiArtifactKind, MeetChapter, MeetDecision,
} from '@tupo/shared';
import {
  generateStructuredContent, generatePlainText, isAnyProviderConfigured,
} from './aiProviders/index.js';
import type { JSONSchema } from './aiProviders/index.js';

/**
 * The AI layer for Meet.
 *
 * Every feature here runs over the *speaker-attributed transcript*, which Tupo
 * gets for free: each caption segment arrives on the socket of the person whose
 * microphone produced it, so there is no diarization step and no speech-to-text
 * bill. The models only ever see text.
 *
 * Everything routes through the four-provider fallback chain ported from
 * TaskMentor, so an OpenAI quota error falls through to Gemini, then Groq, then
 * GLM without the caller knowing.
 */

export { isAnyProviderConfigured };

/* ------------------------------------------------------------------ *
 * Transcript assembly
 * ------------------------------------------------------------------ */

export interface TranscriptLine {
  speaker: string;
  text: string;
  offsetSeconds: number | null;
}

/**
 * Read the transcript for a meeting.
 *
 * Interim segments are excluded: they are the half-formed guesses the browser
 * emits while someone is still talking, and feeding them to a model produces
 * summaries full of sentences nobody said.
 */
export async function loadTranscript(
  meetingId: string, opts: { sinceId?: string; limit?: number } = {},
): Promise<TranscriptLine[]> {
  const { rows } = await getPool().query<{
    speaker_name: string; text: string; offset_seconds: number | null;
  }>(
    `SELECT speaker_name, text, offset_seconds
       FROM meeting_transcript_segments
      WHERE meeting_id = $1 AND is_final = true
        AND ($2::text IS NULL OR id > $2)
      ORDER BY started_at
      LIMIT $3`,
    [meetingId, opts.sinceId ?? null, opts.limit ?? 5000],
  );
  return rows.map((r) => ({
    speaker: r.speaker_name, text: r.text, offsetSeconds: r.offset_seconds,
  }));
}

const mmss = (seconds: number | null): string => {
  if (seconds === null || seconds < 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/**
 * Render the transcript for a prompt, newest-biased.
 *
 * The cap is on characters, not lines, and it keeps the *tail*: a long meeting
 * exceeds any context window, and when it does, the recent discussion is what a
 * summary or a "catch me up" is actually about.
 */
export function renderTranscript(lines: TranscriptLine[], maxChars = 24_000): string {
  const rendered = lines.map((l) => `[${mmss(l.offsetSeconds)}] ${l.speaker}: ${l.text}`);
  let out = rendered.join('\n');
  if (out.length > maxChars) {
    out = `…(earlier discussion omitted)…\n${out.slice(out.length - maxChars)}`;
  }
  return out;
}

export interface MeetingContext {
  title: string;
  description?: string | null;
  participants: string[];
  startedAt?: Date | null;
}

const contextBlock = (ctx: MeetingContext): string =>
  `Meeting title: ${ctx.title}\n` +
  (ctx.description ? `Description: ${ctx.description}\n` : '') +
  `Participants: ${ctx.participants.join(', ') || 'unknown'}\n`;

/**
 * The instruction every prompt opens with. Stated once, here, because the
 * failure mode across all of these features is the same: a model that pads a
 * thin meeting into a plausible-looking record of things nobody said.
 */
const GROUND_RULES =
  'You are the notetaker for a school meeting on the NGA Tupo platform. ' +
  'Work ONLY from the transcript given. Never invent a decision, an owner, a date or a fact ' +
  'that is not in it. If the transcript does not support an answer, say so and return an empty ' +
  'list rather than guessing. The transcript comes from automatic speech recognition, so expect ' +
  'misheard words and repair them from context where it is obvious.\n\n';

/* ------------------------------------------------------------------ *
 * Artifact persistence
 * ------------------------------------------------------------------ */

export async function saveArtifact(
  meetingId: string, kind: MeetAiArtifactKind, content: unknown,
  opts: { providerUsed?: string; segmentCount?: number; requestedBy?: string | null } = {},
): Promise<{ id: string; createdAt: Date }> {
  const id = snowflake();
  const { rows } = await getPool().query<{ created_at: Date }>(
    `INSERT INTO meeting_ai_artifacts
       (id, meeting_id, kind, content, provider_used, segment_count, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING created_at`,
    [id, meetingId, kind, JSON.stringify(content), opts.providerUsed ?? null,
      opts.segmentCount ?? 0, opts.requestedBy ?? null],
  );
  return { id, createdAt: rows[0]!.created_at };
}

export async function latestArtifact(
  meetingId: string, kind: MeetAiArtifactKind,
): Promise<{ id: string; content: unknown; providerUsed: string | null; createdAt: Date } | null> {
  const { rows } = await getPool().query<{
    id: string; content: unknown; provider_used: string | null; created_at: Date;
  }>(
    `SELECT id, content, provider_used, created_at FROM meeting_ai_artifacts
      WHERE meeting_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1`,
    [meetingId, kind],
  );
  if (!rows[0]) return null;
  return {
    id: rows[0].id, content: rows[0].content,
    providerUsed: rows[0].provider_used, createdAt: rows[0].created_at,
  };
}

export async function listArtifacts(meetingId: string) {
  const { rows } = await getPool().query(
    `SELECT DISTINCT ON (kind) id, kind, content, provider_used, created_at
       FROM meeting_ai_artifacts WHERE meeting_id = $1
      ORDER BY kind, created_at DESC`,
    [meetingId],
  );
  return rows;
}

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

const SUMMARY_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One sentence: what this meeting is about so far.' },
    bullets: {
      type: 'array',
      description: 'Three to six points covering what has actually been discussed.',
      items: { type: 'string' },
    },
    topics: { type: 'array', description: 'Short topic labels.', items: { type: 'string' } },
    openQuestions: {
      type: 'array',
      description: 'Questions raised and not yet resolved. Empty if none.',
      items: { type: 'string' },
    },
  },
  required: ['headline', 'bullets', 'topics', 'openQuestions'],
};

const ACTION_ITEMS_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The task, phrased as an instruction.' },
          owner: { type: 'string', description: 'Participant name, or empty if unassigned.' },
          due: { type: 'string', description: 'Due date as stated, or empty.' },
          confidence: { type: 'number', description: '0 to 1: how clearly this was committed to.' },
        },
        required: ['text', 'owner', 'due', 'confidence'],
      },
    },
  },
  required: ['items'],
};

const DECISIONS_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          decision: { type: 'string' },
          context: { type: 'string', description: 'Why, in one sentence.' },
          quote: { type: 'string', description: 'The transcript line that settles it.' },
        },
        required: ['decision', 'context', 'quote'],
      },
    },
  },
  required: ['decisions'],
};

const MINUTES_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string', description: 'A paragraph a non-attendee could read.' },
    agenda: { type: 'array', items: { type: 'string' } },
    discussion: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          points: { type: 'array', items: { type: 'string' } },
        },
        required: ['topic', 'points'],
      },
    },
    decisions: { type: 'array', items: { type: 'string' } },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' }, owner: { type: 'string' }, due: { type: 'string' },
        },
        required: ['text', 'owner', 'due'],
      },
    },
    nextSteps: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'agenda', 'discussion', 'decisions', 'actionItems', 'nextSteps'],
};

const CHAPTERS_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          startOffsetSeconds: { type: 'number', description: 'From the [mm:ss] marks.' },
          summary: { type: 'string' },
        },
        required: ['title', 'startOffsetSeconds', 'summary'],
      },
    },
  },
  required: ['chapters'],
};

const QA_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    grounded: {
      type: 'boolean',
      description: 'False when the transcript does not actually contain the answer.',
    },
    citations: {
      type: 'array',
      description: 'Transcript lines supporting the answer.',
      items: { type: 'string' },
    },
  },
  required: ['answer', 'grounded', 'citations'],
};

const LESSON_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    keyConcepts: { type: 'array', items: { type: 'string' } },
    revisionPoints: {
      type: 'array',
      description: 'What a learner who missed this should study.',
      items: { type: 'string' },
    },
    quizQuestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correctIndex: { type: 'number' },
          explanation: { type: 'string' },
        },
        required: ['question', 'options', 'correctIndex', 'explanation'],
      },
    },
    misconceptions: {
      type: 'array',
      description: 'Confusions actually voiced by learners in the transcript.',
      items: { type: 'string' },
    },
  },
  required: ['keyConcepts', 'revisionPoints', 'quizQuestions', 'misconceptions'],
};

const AGENDA_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    agenda: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string' },
          minutes: { type: 'number' },
          purpose: { type: 'string' },
        },
        required: ['item', 'minutes', 'purpose'],
      },
    },
  },
  required: ['agenda'],
};

/* ------------------------------------------------------------------ *
 * Generators
 * ------------------------------------------------------------------ */

export interface AiResult<T> { data: T; providerUsed: string }

export interface SummaryContent {
  headline: string; bullets: string[]; topics: string[]; openQuestions: string[];
}

/** The rolling in-meeting summary. Called on an interval, not per utterance. */
export async function generateSummary(
  transcript: string, ctx: MeetingContext,
): Promise<AiResult<SummaryContent>> {
  const { data, providerUsed } = await generateStructuredContent<SummaryContent>({
    prompt:
      `${GROUND_RULES}${contextBlock(ctx)}\n` +
      'Summarise the discussion SO FAR. This is a live, mid-meeting summary: describe what has ' +
      'been covered, not what you expect to come next.\n\nTranscript:\n' + transcript,
    schema: SUMMARY_SCHEMA,
    schemaName: 'meeting_summary',
    maxOutputTokens: 1200,
  });
  return { data, providerUsed };
}

export async function generateActionItems(
  transcript: string, ctx: MeetingContext,
): Promise<AiResult<MeetActionItem[]>> {
  const { data, providerUsed } = await generateStructuredContent<{ items: MeetActionItem[] }>({
    prompt:
      `${GROUND_RULES}${contextBlock(ctx)}\n` +
      'Extract action items — things someone committed to DO. Assign an owner only when the ' +
      'transcript names one; match owners against the participant list above and use their exact ' +
      'name. A topic that was merely discussed is not an action item. Return an empty list if ' +
      'nobody committed to anything.\n\nTranscript:\n' + transcript,
    schema: ACTION_ITEMS_SCHEMA,
    schemaName: 'action_items',
    maxOutputTokens: 1500,
  });
  // Normalise the empty-string placeholders the strict schema forces on us.
  const items = (data.items ?? []).map((i) => ({
    ...i,
    owner: i.owner?.trim() || undefined,
    due: i.due?.trim() || undefined,
  }));
  return { data: items, providerUsed };
}

export async function generateDecisions(
  transcript: string, ctx: MeetingContext,
): Promise<AiResult<MeetDecision[]>> {
  const { data, providerUsed } = await generateStructuredContent<{ decisions: MeetDecision[] }>({
    prompt:
      `${GROUND_RULES}${contextBlock(ctx)}\n` +
      'List the decisions the group actually reached. A decision is a settled choice, not a ' +
      'suggestion or an open option. Quote the transcript line that settles each one.\n\n' +
      'Transcript:\n' + transcript,
    schema: DECISIONS_SCHEMA,
    schemaName: 'decisions',
    maxOutputTokens: 1500,
  });
  return { data: data.decisions ?? [], providerUsed };
}

export interface MinutesContent {
  title: string;
  summary: string;
  agenda: string[];
  discussion: Array<{ topic: string; points: string[] }>;
  decisions: string[];
  actionItems: Array<{ text: string; owner: string; due: string }>;
  nextSteps: string[];
}

/** The full post-meeting record. Run once, by the worker, on `meeting.ended`. */
export async function generateMinutes(
  transcript: string, ctx: MeetingContext, chatLog?: string,
): Promise<AiResult<MinutesContent>> {
  const { data, providerUsed } = await generateStructuredContent<MinutesContent>({
    prompt:
      `${GROUND_RULES}${contextBlock(ctx)}\n` +
      'Write the minutes of this meeting: a record someone who was not there can read and ' +
      'understand. Group the discussion by topic in the order it happened. Leave a section ' +
      'empty rather than padding it.\n\n' +
      `Transcript:\n${transcript}\n` +
      (chatLog ? `\nIn-meeting chat (public messages only):\n${chatLog}\n` : ''),
    schema: MINUTES_SCHEMA,
    schemaName: 'meeting_minutes',
    maxOutputTokens: 4000,
  });
  return { data, providerUsed };
}

export async function generateChapters(
  transcript: string, ctx: MeetingContext,
): Promise<AiResult<MeetChapter[]>> {
  const { data, providerUsed } = await generateStructuredContent<{ chapters: MeetChapter[] }>({
    prompt:
      `${GROUND_RULES}${contextBlock(ctx)}\n` +
      'Divide the meeting into chapters by topic. Take each start offset from the [mm:ss] mark ' +
      'on the first line of that chapter and give it in seconds. Between three and ten chapters.' +
      '\n\nTranscript:\n' + transcript,
    schema: CHAPTERS_SCHEMA,
    schemaName: 'chapters',
    maxOutputTokens: 2000,
  });
  return { data: data.chapters ?? [], providerUsed };
}

export interface QaContent { answer: string; grounded: boolean; citations: string[] }

/**
 * "Ask the meeting" and "catch me up" — the same call.
 *
 * `grounded` is the important field: it is what lets the UI show "the meeting
 * has not covered this" instead of a confident answer assembled from nothing.
 */
export async function askMeeting(
  transcript: string, ctx: MeetingContext, question: string,
): Promise<AiResult<QaContent>> {
  const { data, providerUsed } = await generateStructuredContent<QaContent>({
    prompt:
      `${GROUND_RULES}${contextBlock(ctx)}\n` +
      'Answer the question from the transcript alone. If the transcript does not contain the ' +
      'answer, set grounded to false and say plainly that the meeting has not covered it — do ' +
      'not answer from general knowledge.\n\n' +
      `Question: ${question}\n\nTranscript:\n${transcript}`,
    schema: QA_SCHEMA,
    schemaName: 'meeting_qa',
    maxOutputTokens: 1200,
  });
  return { data, providerUsed };
}

export interface LessonFollowUpContent {
  keyConcepts: string[];
  revisionPoints: string[];
  quizQuestions: Array<{ question: string; options: string[]; correctIndex: number; explanation: string }>;
  misconceptions: string[];
}

/** Teaching-specific follow-up. Exportable into TaskMentor's question bank. */
export async function generateLessonFollowUp(
  transcript: string, ctx: MeetingContext,
): Promise<AiResult<LessonFollowUpContent>> {
  const { data, providerUsed } = await generateStructuredContent<LessonFollowUpContent>({
    prompt:
      `${GROUND_RULES}${contextBlock(ctx)}\n` +
      'This was a lesson. Produce follow-up material: the concepts actually taught, what a ' +
      'learner who missed it should revise, four to eight multiple-choice questions with four ' +
      'options each covering only what was taught, and any misconceptions a learner voiced ' +
      'during the lesson.\n\nTranscript:\n' + transcript,
    schema: LESSON_SCHEMA,
    schemaName: 'lesson_followup',
    maxOutputTokens: 4000,
  });
  return { data, providerUsed };
}

export interface AgendaContent {
  agenda: Array<{ item: string; minutes: number; purpose: string }>;
}

/** Pre-meeting: an agenda from the title and description. No transcript yet. */
export async function generateAgenda(
  ctx: MeetingContext, durationMinutes: number,
): Promise<AiResult<AgendaContent>> {
  const { data, providerUsed } = await generateStructuredContent<AgendaContent>({
    prompt:
      'You are helping a teacher or administrator prepare a school meeting on the NGA Tupo ' +
      `platform.\n\n${contextBlock(ctx)}Planned duration: ${durationMinutes} minutes.\n\n` +
      'Propose a realistic agenda whose minutes sum to roughly the planned duration. Each item ' +
      'states what it is FOR — a decision, an update, or a discussion.',
    schema: AGENDA_SCHEMA,
    schemaName: 'agenda',
    maxOutputTokens: 1200,
  });
  return { data, providerUsed };
}

/** One-line title for a meeting the host never named. */
export async function generateTitle(transcript: string): Promise<AiResult<string>> {
  const { data, providerUsed } = await generatePlainText(
    `${GROUND_RULES}Give this meeting a title: at most eight words, no quotation marks, no ` +
    `trailing punctuation, describing what was actually discussed. Reply with the title alone.` +
    `\n\nTranscript:\n${transcript}`,
    100,
  );
  return { data: data.replace(/^["'\s]+|["'.\s]+$/g, '').slice(0, 120), providerUsed };
}

/**
 * Translate one caption. Deliberately a plain-text call: a caption is a fragment
 * of speech, and wrapping it in JSON costs latency the caption cannot afford.
 */
export async function translateCaption(
  text: string, targetLang: string,
): Promise<AiResult<string>> {
  const { data, providerUsed } = await generatePlainText(
    `Translate the following live meeting caption into ${targetLang}. It is a fragment of ` +
    'speech and may be mid-sentence — translate it as it stands. Reply with the translation ' +
    `alone, nothing else.\n\n${text}`,
    400,
  );
  return { data: data.trim(), providerUsed };
}

/* ------------------------------------------------------------------ *
 * Engagement — arithmetic, not a model
 * ------------------------------------------------------------------ */

export interface EngagementReport {
  totalSpeakers: number;
  totalWords: number;
  talkTime: Array<{ speaker: string; words: number; share: number; segments: number }>;
  silentParticipants: string[];
  /** 0–1 Gini-style evenness. 1 means everyone spoke equally. */
  balanceScore: number;
  narrative?: string;
}

/**
 * Participation balance for lesson-delivery evidence (FR-MEET-15).
 *
 * Computed from the transcript rather than generated: "who spoke how much" is
 * counting, and a model asked to count will approximate. Only the closing
 * narrative is generated, and only when the caller asks for it.
 */
export function computeEngagement(
  lines: TranscriptLine[], allParticipants: string[],
): EngagementReport {
  const byspeaker = new Map<string, { words: number; segments: number }>();
  let totalWords = 0;

  for (const line of lines) {
    const words = line.text.trim().split(/\s+/).filter(Boolean).length;
    totalWords += words;
    const cur = byspeaker.get(line.speaker) ?? { words: 0, segments: 0 };
    cur.words += words;
    cur.segments += 1;
    byspeaker.set(line.speaker, cur);
  }

  const talkTime = [...byspeaker.entries()]
    .map(([speaker, v]) => ({
      speaker, words: v.words, segments: v.segments,
      share: totalWords > 0 ? v.words / totalWords : 0,
    }))
    .sort((a, b) => b.words - a.words);

  const silentParticipants = allParticipants.filter((name) => !byspeaker.has(name));

  // Evenness against a perfectly equal split across *everyone present*, not
  // just everyone who spoke — otherwise a lesson where one pupil answered every
  // question scores as perfectly balanced.
  const n = Math.max(allParticipants.length, talkTime.length, 1);
  const ideal = 1 / n;
  const deviation = [...Array(n).keys()].reduce((acc, i) => {
    const share = talkTime[i]?.share ?? 0;
    return acc + Math.abs(share - ideal);
  }, 0);
  const balanceScore = Math.max(0, 1 - deviation / 2);

  return {
    totalSpeakers: talkTime.length,
    totalWords,
    talkTime,
    silentParticipants,
    balanceScore: Number(balanceScore.toFixed(3)),
  };
}

export async function narrateEngagement(
  report: EngagementReport, ctx: MeetingContext,
): Promise<AiResult<string>> {
  const { data, providerUsed } = await generatePlainText(
    `${contextBlock(ctx)}\nParticipation statistics for this meeting:\n` +
    report.talkTime.map((t) => `- ${t.speaker}: ${t.words} words (${Math.round(t.share * 100)}%)`).join('\n') +
    (report.silentParticipants.length
      ? `\nPresent but never spoke: ${report.silentParticipants.join(', ')}`
      : '') +
    `\nBalance score: ${report.balanceScore} (1.0 = perfectly even)\n\n` +
    'Write two or three sentences a teacher could put in a lesson record. Describe the ' +
    'participation pattern factually. Do not praise or criticise anyone by name, and do not ' +
    'speculate about why someone was quiet.',
    500,
  );
  return { data, providerUsed };
}
