import {
  apiGet, apiPost, apiPut, apiPatch, apiDelete, apiDownload, SESSION_KEY, ApiError,
} from '../../lib/api';
import type {
  MeetJoinTicket, MeetSettings, MeetActionItem, MeetChapter, MeetDecision, MeetNote,
  MeetRecording, MeetTransport, NoteSource, RecordingMode, RTCIceServerLike,
} from '@tupo/shared';
import { meetingFolder } from '@tupo/shared';

/** Meet's REST surface, typed. Everything else in the module goes through here. */

export interface MeetCapabilities {
  sfu: boolean;
  turn: boolean;
  ai: boolean;
  aiProviders: Record<string, boolean>;
  meshMaxParticipants: number;
  maxVideoTiles: number;
  aiSummaryIntervalMs: number;
  aiParticipantName: string;
  admissionPolicies: Array<{ value: string; label: string; hint: string }>;
  categories: Array<{ value: string; policy: string; label: string; hint: string; warning?: string }>;
  maxRecordingBytes: number;
}

export interface MeetingListItem {
  id: string;
  title: string;
  description: string | null;
  status: 'scheduled' | 'live' | 'ended' | 'cancelled';
  join_code: string;
  host_id: string;
  host_name: string;
  host_avatar: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  started_at: string | null;
  ended_at: string | null;
  active_count: number;
  peak_participants: number;
  has_minutes: boolean;
  settings: MeetSettings;
  /** Up to six people currently in the room — a face is a faster answer than a count. */
  present?: MeetPresentPerson[];
}

export interface MeetPresentPerson {
  name: string;
  avatar: string | null;
  role: string;
}

/** A live meeting this user may walk into, whether or not they were invited. */
export interface LiveMeetingSummary {
  id: string;
  title: string;
  joinCode: string;
  startedAt: string | null;
  hostName: string;
  hostAvatar: string | null;
  activeCount: number;
  present: MeetPresentPerson[];
  isMine: boolean;
}

/**
 * Live meetings this person may join right now.
 *
 * Distinct from `listMeetings('live')`, which lists meetings you own or were
 * invited to. This also surfaces meetings whose category admits any signed-in
 * user — the ones no invitation row exists for.
 */
export const listLiveMeetings = () =>
  apiGet<LiveMeetingSummary[]>('/api/meet/live').then((r) => r.data ?? []);

export interface MeetingDetail extends MeetingListItem {
  room_name: string;
  transport: 'mesh' | 'sfu' | null;
  media_mode: string;
  recurrence_rule: string | null;
  yourRole: 'attendee' | 'presenter' | 'cohost' | 'host';
  participants: Array<{
    id: string; display_name: string; role: string; state: string;
    joined_at: string | null; left_at: string | null;
    duration_seconds: number; avatar_url: string | null;
  }>;
}

export interface AiArtifact {
  id: string;
  kind: string;
  content: unknown;
  provider_used?: string | null;
  providerUsed?: string | null;
  created_at?: string;
  createdAt?: string;
}

export const getCapabilities = () =>
  apiGet<MeetCapabilities>('/api/meet/capabilities').then((r) => r.data!);

export const getIceServers = () =>
  apiGet<{ iceServers: RTCIceServerLike[] }>('/api/meet/ice').then((r) => r.data!.iceServers);

export interface MeetingQuery {
  scope?: 'mine' | 'upcoming' | 'live' | 'past';
  /** Inclusive window over when the meeting happened, as ISO instants. */
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

/** The history view: a window, a search, and a page at a time. */
export const queryMeetings = (query: MeetingQuery) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') params.set(k, String(v));
  }
  return apiGet<MeetingListItem[]>(`/api/meet?${params}`).then((r) => r.data ?? []);
};

export const listMeetings = (scope: 'mine' | 'upcoming' | 'live' | 'past' = 'mine') =>
  apiGet<MeetingListItem[]>(`/api/meet?scope=${scope}`).then((r) => r.data ?? []);

export const getMeeting = (idOrCode: string) =>
  apiGet<MeetingDetail>(`/api/meet/${encodeURIComponent(idOrCode)}`).then((r) => r.data!);

export const createMeeting = (body: Record<string, unknown>) =>
  apiPost<MeetingDetail>('/api/meet', body).then((r) => r.data!);

export const startInstant = (body: Record<string, unknown> = {}) =>
  apiPost<MeetingDetail>('/api/meet/instant', body).then((r) => r.data!);

export const updateMeeting = (id: string, body: Record<string, unknown>) =>
  apiPatch<MeetingDetail>(`/api/meet/${id}`, body).then((r) => r.data!);

export const cancelMeeting = (id: string) =>
  apiDelete<{ cancelled: boolean }>(`/api/meet/${id}`);

export const joinMeeting = (idOrCode: string, body: Record<string, unknown> = {}) =>
  apiPost<MeetJoinTicket>(`/api/meet/${encodeURIComponent(idOrCode)}/join`, body).then((r) => r.data!);

/** Called the moment the host admits someone out of the lobby. */
export const refreshToken = (id: string) =>
  apiPost<{
    transport: MeetTransport; iceServers: RTCIceServerLike[]; sfuEndpoint?: string;
  }>(`/api/meet/${id}/token`).then((r) => r.data!);

export const leaveMeeting = (id: string) => apiPost(`/api/meet/${id}/leave`);
export const endMeeting = (id: string) => apiPost(`/api/meet/${id}/end`);

export const saveSettings = (id: string, patch: Partial<MeetSettings>) =>
  apiPut<MeetSettings>(`/api/meet/${id}/settings`, patch).then((r) => r.data!);

export const getAttendance = (id: string) =>
  apiGet<{
    meeting: { id: string; title: string; startedAt: string | null; endedAt: string | null; peakParticipants: number };
    participants: Array<Record<string, unknown>>;
  }>(`/api/meet/${id}/attendance`).then((r) => r.data!);

export const getEvents = (id: string, severity?: string) =>
  apiGet<Array<{
    id: string; type: string; severity: string; payload: Record<string, unknown>;
    created_at: string; participant_id: string | null; display_name: string | null;
  }>>(`/api/meet/${id}/events${severity ? `?severity=${severity}` : ''}`).then((r) => r.data ?? []);

export const getTranscript = (id: string) =>
  apiGet<Array<{ speaker: string; text: string; offsetSeconds: number | null }>>(
    `/api/meet/${id}/transcript`).then((r) => r.data ?? []);

export const getArtifacts = (id: string) =>
  apiGet<AiArtifact[]>(`/api/meet/${id}/ai`).then((r) => r.data ?? []);

/* --- AI generators. Each returns the artifact it just produced. --- */

const aiCall = <T>(id: string, path: string, body: Record<string, unknown> = {}) =>
  apiPost<{ id: string; kind: string; content: T; providerUsed: string }>(
    `/api/meet/${id}/ai/${path}`, body).then((r) => r.data!);

export interface SummaryContent {
  headline: string; bullets: string[]; topics: string[]; openQuestions: string[];
}
export interface MinutesContent {
  title: string; summary: string; agenda: string[];
  discussion: Array<{ topic: string; points: string[] }>;
  decisions: string[];
  actionItems: Array<{ text: string; owner: string; due: string }>;
  nextSteps: string[];
}
export interface EngagementContent {
  totalSpeakers: number; totalWords: number;
  talkTime: Array<{ speaker: string; words: number; share: number; segments: number }>;
  silentParticipants: string[]; balanceScore: number; narrative?: string;
}
export interface LessonFollowUpContent {
  keyConcepts: string[]; revisionPoints: string[];
  quizQuestions: Array<{ question: string; options: string[]; correctIndex: number; explanation: string }>;
  misconceptions: string[];
}

export const aiSummary = (id: string) => aiCall<SummaryContent>(id, 'summary');
export const aiActionItems = (id: string) => aiCall<MeetActionItem[]>(id, 'action-items');
export const aiDecisions = (id: string) => aiCall<MeetDecision[]>(id, 'decisions');
export const aiMinutes = (id: string) => aiCall<MinutesContent>(id, 'minutes');
export const aiChapters = (id: string) => aiCall<MeetChapter[]>(id, 'chapters');
export const aiLessonFollowUp = (id: string) => aiCall<LessonFollowUpContent>(id, 'lesson-followup');
export const aiEngagement = (id: string, narrate = true) =>
  aiCall<EngagementContent>(id, 'engagement', { narrate });
export const aiAgenda = (id: string, durationMinutes?: number) =>
  aiCall<{ agenda: Array<{ item: string; minutes: number; purpose: string }> }>(
    id, 'agenda', { durationMinutes });

export const aiAsk = (id: string, question: string) =>
  apiPost<{ answer: string; grounded: boolean; citations: string[]; providerUsed: string }>(
    `/api/meet/${id}/ai/ask`, { question }).then((r) => r.data!);

export const aiTranslate = (id: string, text: string, targetLang: string) =>
  apiPost<{ text: string; providerUsed: string }>(
    `/api/meet/${id}/ai/translate`, { text, targetLang }).then((r) => r.data!);

/* --- Directory, naming and deletion --- */

export interface DirectoryPerson {
  id: string; name: string; email: string;
  avatar_url: string | null; role_name: string | null;
}

/** People search for choosing who a private meeting is for. */
export const searchDirectory = (q: string) =>
  apiGet<DirectoryPerson[]>(`/api/meet/directory?q=${encodeURIComponent(q)}`)
    .then((r) => r.data ?? []);

export const renameMeeting = (id: string, title: string) =>
  apiPut<{ title: string }>(`/api/meet/${id}/name`, { title }).then((r) => r.data!);

/**
 * `purge` is the difference between cancelling and deleting. Cancelling keeps
 * the attendance record; deleting destroys it, along with the transcript and
 * every note. Only the person who created the meeting may do either.
 */
export const removeMeeting = (id: string, purge = false) =>
  apiDelete<{ cancelled: boolean; deleted: boolean }>(
    `/api/meet/${id}${purge ? '?purge=true' : ''}`).then((r) => r.data!);

/* --- Recording --- */

export const startRecording = (id: string, mode?: RecordingMode) =>
  apiPost<{ recordingId: string; mode: RecordingMode; folder: string; maxBytes: number }>(
    `/api/meet/${id}/recording/start`, mode ? { mode } : {}).then((r) => r.data!);

export const stopRecording = (id: string) => apiPost(`/api/meet/${id}/recording/stop`);

export const failRecording = (meetingId: string, recordingId: string) =>
  apiPost(`/api/meet/${meetingId}/recordings/${recordingId}/fail`);

export const listRecordings = (id: string) =>
  apiGet<Array<MeetRecording & {
    started_by_name: string | null; original_name: string | null; file_id: string | null;
    duration_seconds: number | null; size_bytes: number | null;
    started_at: string; ended_at: string | null;
  }>>(`/api/meet/${id}/recordings`).then((r) => r.data ?? []);

export const downloadRecording = (fileId: string, filename: string) =>
  apiDownload(`/api/files/${fileId}/content`, filename);

/**
 * Upload a finished client-side recording.
 *
 * Three steps, and they are separate for a reason: the bytes go straight to the
 * file service (which is built to stream them) while the API only ever learns
 * the resulting file id. The `folder` puts it with the rest of the meeting's
 * media, and the service validates that folder rather than trusting it.
 */
export async function uploadRecording(p: {
  meetingId: string;
  recordingId: string;
  blob: Blob;
  filename: string;
  durationSeconds: number;
}): Promise<void> {
  const token = localStorage.getItem(SESSION_KEY);

  const ticketRes = await fetch('/api/files/tickets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      name: p.filename,
      size: p.blob.size,
      mime: p.blob.type || 'video/webm',
      folder: meetingFolder(p.meetingId),
    }),
  });
  const ticket = await ticketRes.json();
  if (!ticketRes.ok || ticket.success === false) {
    throw new ApiError(ticket.message ?? 'Could not reserve storage for the recording.',
      ticketRes.status);
  }

  // The ticket's uploadUrl is already an /api/files path, which the same proxy
  // rule routes to the file service.
  const uploadRes = await fetch(ticket.data.uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': p.blob.type || 'video/webm',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: p.blob,
  });
  if (!uploadRes.ok) {
    throw new ApiError(`The recording could not be uploaded (${uploadRes.status}).`, uploadRes.status);
  }

  await apiPost(`/api/meet/${p.meetingId}/recordings/${p.recordingId}/attach`, {
    fileId: ticket.data.fileId,
    durationSeconds: p.durationSeconds,
    sizeBytes: p.blob.size,
  });
}

/* --- Downloads --- */

export const downloadAttendanceCsv = (id: string, code: string) =>
  apiDownload(`/api/meet/${id}/attendance?format=csv`, `attendance-${code}.csv`);

export const downloadTranscript = (id: string, code: string) =>
  apiDownload(`/api/meet/${id}/transcript?format=txt`, `transcript-${code}.txt`);

export const downloadIcs = (id: string, code: string) =>
  apiDownload(`/api/meet/${id}/ics`, `${code}.ics`);


/* ------------------------------------------------------------------ *
 * Notes
 * ------------------------------------------------------------------ */

export const listNotes = (meetingId: string) =>
  apiGet<MeetNote[]>(`/api/meet/${meetingId}/notes`).then((r) => r.data ?? []);

export const createNote = (
  meetingId: string, body: { body: string; source?: NoteSource; isShared?: boolean },
) => apiPost<MeetNote>(`/api/meet/${meetingId}/notes`, body).then((r) => r.data!);

export const updateNote = (
  meetingId: string, noteId: string,
  patch: { body?: string; isShared?: boolean; pinned?: boolean },
) => apiPatch<MeetNote>(`/api/meet/${meetingId}/notes/${noteId}`, patch).then((r) => r.data!);

export const deleteNote = (meetingId: string, noteId: string) =>
  apiDelete<{ deleted: boolean }>(`/api/meet/${meetingId}/notes/${noteId}`);

/** One tap: save the last `seconds` of transcript as a note. */
export const captureNote = (meetingId: string, seconds = 45) =>
  apiPost<MeetNote>(`/api/meet/${meetingId}/notes/capture`, { seconds }).then((r) => r.data!);

/** AI clean-up that keeps the author's meaning. Reversible via restoreNote. */
export const tidyNote = (meetingId: string, noteId: string) =>
  apiPost<MeetNote>(`/api/meet/${meetingId}/notes/${noteId}/tidy`).then((r) => r.data!);

export const restoreNote = (meetingId: string, noteId: string) =>
  apiPost<MeetNote>(`/api/meet/${meetingId}/notes/${noteId}/restore`).then((r) => r.data!);

/* ------------------------------------------------------------------ *
 * Guests — the public-meeting path
 * ------------------------------------------------------------------ */

export interface PublicMeetingInfo {
  meetingId: string;
  title: string;
  joinCode: string;
  hostName: string;
  status: string;
  lobbyEnabled: boolean;
}

/** What a stranger may see about a meeting before committing to join it. */
export const getPublicMeeting = (idOrCode: string) =>
  apiGet<PublicMeetingInfo>(`/api/meet/${encodeURIComponent(idOrCode)}/public`)
    .then((r) => r.data!);

export const joinAsGuest = (idOrCode: string, displayName: string) =>
  apiPost<MeetJoinTicket>(`/api/meet/${encodeURIComponent(idOrCode)}/guest`, { displayName })
    .then((r) => r.data!);
