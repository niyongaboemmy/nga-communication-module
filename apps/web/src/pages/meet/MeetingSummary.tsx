import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, BarChart3, CalendarPlus, CheckSquare, Download, FileText,
  GraduationCap, Loader2, Play, Share2, Sparkles, Trash2, Users, Video,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useNotify } from '../../context/NotificationContext';
import { usePermissions } from '../../hooks/usePermissions';
import { Avatar, Button, Card, EmptyState } from '../../components/ui';
import { ShareMeeting } from './ShareMeeting';
import * as meetApi from './api';
import type {
  EngagementContent, LessonFollowUpContent, MinutesContent,
} from './api';

/**
 * Format an attendance duration.
 *
 * Rounding to whole minutes reports "0 min" for anyone who was there for fifty
 * seconds, which reads as "did not attend" — the opposite of what the record is
 * for. Short stays are reported in seconds instead.
 */
function duration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 600) return `${(seconds / 60).toFixed(1)} min`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * Everything a meeting leaves behind (FR-MEET-15).
 *
 * Doubles as the detail page for a meeting that has not happened yet, because
 * the same things matter before and after: who is coming, what the settings
 * are, and how to get in. Splitting them into two pages would mean two places
 * to look for one meeting.
 */

type Tab = 'overview' | 'minutes' | 'attendance' | 'transcript' | 'recordings' | 'insights';

const prettyBytes = (bytes: number | null): string => {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
};

export const MeetingSummary: React.FC = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { user } = useAuth();
  const { notify } = useNotify();

  const [meeting, setMeeting] = useState<meetApi.MeetingDetail | null>(null);
  const [recordings, setRecordings] = useState<Awaited<ReturnType<typeof meetApi.listRecordings>>>([]);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [artifacts, setArtifacts] = useState<meetApi.AiArtifact[]>([]);
  const [transcript, setTranscript] = useState<Array<{ speaker: string; text: string; offsetSeconds: number | null }>>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canUseAi = can('MEET_AI_USE');
  const canViewAttendance = can('MEET_ATTENDANCE_VIEW');
  const isHost = meeting?.yourRole === 'host' || meeting?.yourRole === 'cohost';

  const load = useCallback(async () => {
    try {
      const [detail, arts, recs] = await Promise.all([
        meetApi.getMeeting(id),
        meetApi.getArtifacts(id).catch(() => []),
        meetApi.listRecordings(id).catch(() => []),
      ]);
      setMeeting(detail);
      setArtifacts(arts);
      setRecordings(recs);
      // The transcript can be long; it is only fetched when there might be one.
      if (detail.status === 'ended') {
        setTranscript(await meetApi.getTranscript(id).catch(() => []));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this meeting.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const artifact = <T,>(kind: string): T | null => {
    const found = artifacts.find((a) => a.kind === kind);
    return found ? (found.content as T) : null;
  };
  const providerFor = (kind: string) =>
    artifacts.find((a) => a.kind === kind)?.provider_used ??
    artifacts.find((a) => a.kind === kind)?.providerUsed ?? null;

  const generate = async (kind: string, fn: () => Promise<unknown>) => {
    setGenerating(kind);
    setError(null);
    try {
      await fn();
      setArtifacts(await meetApi.getArtifacts(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The AI could not generate that.');
    } finally {
      setGenerating(null);
    }
  };

  if (loading) {
    return (
      <div className="grid h-full place-items-center">
        <Loader2 size={20} className="animate-spin text-text-secondary-light" />
      </div>
    );
  }

  if (!meeting) {
    return <EmptyState title="Meeting not found" hint={error ?? 'It may have been cancelled.'} />;
  }

  const minutes = artifact<MinutesContent>('minutes');
  const engagement = artifact<EngagementContent>('engagement');
  const lesson = artifact<LessonFollowUpContent>('lesson_followup');
  const actionItems = artifact<Array<{ text: string; owner?: string; due?: string }>>('action_items');
  const ended = meeting.status === 'ended';
  // Deleting destroys the attendance record, the transcript and every note, so
  // it belongs to the person who created the meeting and nobody else — not a
  // co-host, not an administrator. They have "end" and "cancel" instead.
  const isCreator = !!user && meeting.host_id === user.id;
  const readyRecordings = recordings.filter((r) => r.status === 'ready' && r.file_id);

  return (
    <div className="tupo-aurora mx-auto max-w-7xl space-y-5 p-4 sm:p-6 lg:px-8">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* The way back. This page is reached from four different places and
              offered no route out of any of them. */}
          <button
            onClick={() => navigate('/app/meet')}
            className="mb-1 flex items-center gap-1 text-xs font-medium text-text-secondary-light transition-colors duration-150 hover:text-text-primary-light dark:text-text-secondary-dark dark:hover:text-text-primary-dark"
          >
            <ArrowLeft size={13} /> Meet
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary-light dark:text-text-primary-dark">
              {minutes?.title || meeting.title}
            </h1>
            <StatusChip status={meeting.status} />
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-text-secondary-light dark:text-text-secondary-dark">
            <span>{meeting.host_name}</span>
            <span aria-hidden="true">·</span>
            <span>
              {meeting.started_at
                ? new Date(meeting.started_at).toLocaleString([], {
                    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                : meeting.scheduled_start
                  ? new Date(meeting.scheduled_start).toLocaleString([], {
                      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                  : 'Not scheduled'}
            </span>
            {meeting.started_at && meeting.ended_at && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {Math.max(1, Math.round(
                    (Date.parse(meeting.ended_at) - Date.parse(meeting.started_at)) / 60_000))} min
                </span>
              </>
            )}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {!ended && (
            <Button size="sm" onClick={() => navigate(`/app/meet/${meeting.id}`)}>
              <Video size={14} /> {meeting.status === 'live' ? 'Join' : 'Start'}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setSharing(true)}>
            <Share2 size={14} /> Share
          </Button>
          {!ended && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void meetApi.downloadIcs(meeting.id, meeting.join_code)}
            >
              <CalendarPlus size={14} /> Calendar
            </Button>
          )}
          {isCreator && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfirmDelete(true)}
              className="text-red-600 dark:text-red-400"
            >
              <Trash2 size={14} /> Delete
            </Button>
          )}
        </div>
      </header>

      {sharing && (
        <ShareMeeting
          meetingId={meeting.id}
          joinCode={meeting.join_code}
          title={meeting.title}
          startsAt={meeting.scheduled_start}
          admission={meeting.settings.admissionPolicy}
          onClose={() => setSharing(false)}
        />
      )}

      {error && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {error}
        </p>
      )}

      <nav className="flex gap-1 overflow-x-auto border-b border-border-light pb-px dark:border-border-dark/40">
        {([
          ['overview', 'Overview', FileText],
          ...(ended ? [['minutes', 'Minutes', Sparkles] as const] : []),
          ...(canViewAttendance ? [['attendance', 'Attendance', Users] as const] : []),
          ...(ended ? [['transcript', 'Transcript', FileText] as const] : []),
          ...(recordings.length ? [['recordings', 'Recordings', Play] as const] : []),
          ...(ended && isHost ? [['insights', 'Insights', BarChart3] as const] : []),
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key as Tab)}
            className={
              'flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ' +
              (tab === key
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-text-secondary-light hover:text-text-primary-light dark:text-text-secondary-dark dark:hover:text-text-primary-dark')
            }
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </nav>

      {/* ---- Overview ---- */}
      {tab === 'overview' && (
        <div className="space-y-4">
          {meeting.description && (
            <Card className="p-4">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary-light dark:text-text-primary-dark">
                {meeting.description}
              </p>
            </Card>
          )}

          {actionItems && actionItems.length > 0 && (
            <Card className="p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
                <CheckSquare size={15} className="text-blue-500" /> Action items
              </h2>
              <ul className="space-y-1.5">
                {actionItems.map((a, i) => (
                  <li key={i} className="flex gap-2 text-sm text-text-primary-light dark:text-text-primary-dark">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />
                    <span>
                      {a.text}
                      {a.owner && <span className="ml-1.5 text-xs text-blue-600 dark:text-blue-400">{a.owner}</span>}
                      {a.due && <span className="ml-1.5 text-xs text-text-secondary-light">due {a.due}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="p-4">
            <h2 className="mb-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              {ended ? 'Who was there' : 'Invited'}
            </h2>
            {meeting.participants.length === 0 ? (
              <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark">
                Nobody has joined yet.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {meeting.participants.map((p) => (
                  <li key={p.id} className="flex items-center gap-2.5">
                    <Avatar name={p.display_name} src={p.avatar_url ?? undefined} size={26} />
                    <span className="min-w-0 flex-1 truncate text-sm text-text-primary-light dark:text-text-primary-dark">
                      {p.display_name}
                    </span>
                    {p.duration_seconds > 0 && (
                      <span className="shrink-0 text-xs tabular-nums text-text-secondary-light dark:text-text-secondary-dark">
                        {duration(p.duration_seconds)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {/* ---- Minutes ---- */}
      {tab === 'minutes' && (
        minutes ? (
          <Card className="space-y-5 p-5">
            <p className="text-sm leading-relaxed text-text-primary-light dark:text-text-primary-dark">
              {minutes.summary}
            </p>

            {minutes.discussion.length > 0 && (
              <Block title="Discussion">
                {minutes.discussion.map((d, i) => (
                  <div key={i} className="mb-3">
                    <h4 className="text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
                      {d.topic}
                    </h4>
                    <ul className="mt-1 space-y-1">
                      {d.points.map((point, j) => (
                        <li key={j} className="flex gap-2 text-sm text-text-secondary-light dark:text-text-secondary-dark">
                          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current opacity-50" />
                          {point}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </Block>
            )}

            {minutes.decisions.length > 0 && (
              <Block title="Decisions">
                <ul className="space-y-1.5">
                  {minutes.decisions.map((d, i) => (
                    <li key={i} className="text-sm text-text-primary-light dark:text-text-primary-dark">{d}</li>
                  ))}
                </ul>
              </Block>
            )}

            {minutes.actionItems.length > 0 && (
              <Block title="Actions">
                <ul className="space-y-1.5">
                  {minutes.actionItems.map((a, i) => (
                    <li key={i} className="text-sm text-text-primary-light dark:text-text-primary-dark">
                      {a.text}
                      {a.owner && <span className="ml-1.5 text-xs text-blue-600 dark:text-blue-400">{a.owner}</span>}
                      {a.due && <span className="ml-1.5 text-xs text-text-secondary-light">due {a.due}</span>}
                    </li>
                  ))}
                </ul>
              </Block>
            )}

            {minutes.nextSteps.length > 0 && (
              <Block title="Next steps">
                <ul className="space-y-1.5">
                  {minutes.nextSteps.map((n, i) => (
                    <li key={i} className="text-sm text-text-primary-light dark:text-text-primary-dark">{n}</li>
                  ))}
                </ul>
              </Block>
            )}

            <Provenance provider={providerFor('minutes')} />
          </Card>
        ) : (
          <GenerateCard
            title="No minutes yet"
            body={transcript.length < 5
              ? 'There is not enough transcript. Minutes need live captions to have been on during the meeting.'
              : 'Generate a full record of the meeting from its transcript.'}
            disabled={!canUseAi || transcript.length < 5}
            busy={generating === 'minutes'}
            onGenerate={() => void generate('minutes', () => meetApi.aiMinutes(id))}
          />
        )
      )}

      {/* ---- Attendance ---- */}
      {tab === 'attendance' && (
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              Attendance
            </h2>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void meetApi.downloadAttendanceCsv(meeting.id, meeting.join_code)}
            >
              <Download size={14} /> CSV
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-light text-left text-xs text-text-secondary-light dark:border-border-dark/40 dark:text-text-secondary-dark">
                  <th className="pb-2 pr-3 font-medium">Name</th>
                  <th className="pb-2 pr-3 font-medium">Joined</th>
                  <th className="pb-2 pr-3 font-medium">Left</th>
                  <th className="pb-2 font-medium">Time in call</th>
                </tr>
              </thead>
              <tbody>
                {meeting.participants.map((p) => (
                  <tr key={p.id} className="border-b border-border-light/50 dark:border-border-dark/20">
                    <td className="py-2 pr-3 text-text-primary-light dark:text-text-primary-dark">
                      {p.display_name}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-text-secondary-light dark:text-text-secondary-dark">
                      {p.joined_at ? new Date(p.joined_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-text-secondary-light dark:text-text-secondary-dark">
                      {p.left_at ? new Date(p.left_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                    </td>
                    <td className="py-2 tabular-nums text-text-secondary-light dark:text-text-secondary-dark">
                      {duration(p.duration_seconds)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ---- Transcript ---- */}
      {tab === 'transcript' && (
        transcript.length === 0 ? (
          <EmptyState
            title="No transcript"
            hint="Live captions were not switched on during this meeting."
          />
        ) : (
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
                Transcript
              </h2>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void meetApi.downloadTranscript(meeting.id, meeting.join_code)}
              >
                <Download size={14} /> Text
              </Button>
            </div>
            <div className="max-h-[60vh] space-y-2 overflow-y-auto">
              {transcript.map((line, i) => (
                <p key={i} className="text-sm leading-relaxed">
                  {line.offsetSeconds !== null && (
                    <span className="mr-2 font-mono text-xs text-text-secondary-light/60">
                      {String(Math.floor(line.offsetSeconds / 60)).padStart(2, '0')}:
                      {String(Math.floor(line.offsetSeconds % 60)).padStart(2, '0')}
                    </span>
                  )}
                  <span className="font-medium text-blue-600 dark:text-blue-400">{line.speaker}:</span>{' '}
                  <span className="text-text-primary-light dark:text-text-primary-dark">{line.text}</span>
                </p>
              ))}
            </div>
          </Card>
        )
      )}

      {/* ---- Recordings ---- */}
      {tab === 'recordings' && (
        recordings.length === 0 ? (
          <EmptyState title="No recordings" hint="This meeting was not recorded." />
        ) : (
          <div className="space-y-3">
            {recordings.map((rec) => (
              <Card key={rec.id} className="p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                    <Play size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
                      {new Date(rec.started_at).toLocaleString([], {
                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                      {rec.duration_seconds ? <span>{duration(rec.duration_seconds)}</span> : null}
                      {rec.size_bytes ? <span>{prettyBytes(rec.size_bytes)}</span> : null}
                      {rec.started_by_name && <span>by {rec.started_by_name}</span>}
                      {/* The two modes have different guarantees, so which one
                          produced a recording is worth stating plainly. */}
                      <span className="rounded bg-surface-light px-1.5 py-0.5 text-[10px] dark:bg-slate-700/50">
                        {rec.mode === 'client' ? 'Recorded in the browser' : 'Recorded by the media server'}
                      </span>
                      {rec.status !== 'ready' && (
                        <span className="text-amber-600 dark:text-amber-400">{rec.status}</span>
                      )}
                    </p>
                  </div>
                  {rec.status === 'ready' && rec.file_id && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void meetApi.downloadRecording(
                        rec.file_id!, rec.original_name ?? `recording-${rec.id}.webm`)}
                    >
                      <Download size={14} /> Download
                    </Button>
                  )}
                </div>

                {rec.status === 'ready' && rec.file_id && (
                  <video
                    controls
                    preload="metadata"
                    src={`/api/files/${rec.file_id}/content`}
                    className="mt-3 w-full rounded-xl bg-black"
                  />
                )}
              </Card>
            ))}
            {readyRecordings.length > 0 && (
              <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
                Stored under <code>meetings/{meeting.id}</code> — every recording for this meeting
                sits together, so it can be exported or removed as one.
              </p>
            )}
          </div>
        )
      )}

      {/* ---- Delete ---- */}
      {confirmDelete && (
        <div className="fixed inset-0 z-90 grid place-items-center bg-black/50 p-4">
          <Card className="animate-pop w-full max-w-md p-5">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400">
                <AlertTriangle size={19} />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
                  Delete “{meeting.title}”?
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-text-secondary-light dark:text-text-secondary-dark">
                  This removes the attendance record, the transcript, the notes, the chat and any
                  recordings. It cannot be undone, and nobody else can do it — only you, because
                  you created this meeting.
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await meetApi.removeMeeting(meeting.id, true);
                    notify({
                      title: 'Meeting deleted',
                      body: `“${meeting.title}” and everything it held is gone.`,
                      tone: 'success',
                    });
                    navigate('/app/meet');
                  } catch (err) {
                    notify({
                      title: 'Could not delete the meeting',
                      body: err instanceof Error ? err.message : undefined,
                      tone: 'error',
                    });
                    setDeleting(false);
                    setConfirmDelete(false);
                  }
                }}
              >
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                Delete permanently
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* ---- Insights ---- */}
      {tab === 'insights' && (
        <div className="space-y-4">
          {engagement ? (
            <Card className="p-4">
              <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
                <BarChart3 size={15} className="text-blue-500" /> Participation
              </h2>
              {engagement.narrative && (
                <p className="mb-3 text-sm leading-relaxed text-text-secondary-light dark:text-text-secondary-dark">
                  {engagement.narrative}
                </p>
              )}
              <ul className="space-y-2">
                {engagement.talkTime.map((t) => (
                  <li key={t.speaker}>
                    <div className="mb-0.5 flex justify-between text-xs">
                      <span className="text-text-primary-light dark:text-text-primary-dark">{t.speaker}</span>
                      <span className="tabular-nums text-text-secondary-light dark:text-text-secondary-dark">
                        {Math.round(t.share * 100)}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-light dark:bg-slate-700/50">
                      <div className="h-full rounded-full bg-blue-500" style={{ width: `${t.share * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
              {engagement.silentParticipants.length > 0 && (
                <p className="mt-3 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                  Present but never spoke: {engagement.silentParticipants.join(', ')}
                </p>
              )}
              <Provenance provider={providerFor('engagement')} />
            </Card>
          ) : (
            <GenerateCard
              title="Participation report"
              body="Talk-time balance and who never spoke — useful evidence for a lesson record."
              disabled={!canViewAttendance || transcript.length < 2}
              busy={generating === 'engagement'}
              onGenerate={() => void generate('engagement', () => meetApi.aiEngagement(id))}
            />
          )}

          {lesson ? (
            <Card className="space-y-4 p-4">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
                <GraduationCap size={15} className="text-blue-500" /> Lesson follow-up
              </h2>
              {lesson.keyConcepts.length > 0 && (
                <Block title="Concepts covered">
                  <div className="flex flex-wrap gap-1.5">
                    {lesson.keyConcepts.map((c) => (
                      <span key={c} className="rounded-full bg-surface-light px-2 py-0.5 text-xs text-text-secondary-light dark:bg-slate-700/40 dark:text-text-secondary-dark">
                        {c}
                      </span>
                    ))}
                  </div>
                </Block>
              )}
              {lesson.misconceptions.length > 0 && (
                <Block title="Confusions worth revisiting">
                  <ul className="space-y-1">
                    {lesson.misconceptions.map((m, i) => (
                      <li key={i} className="text-sm text-text-secondary-light dark:text-text-secondary-dark">{m}</li>
                    ))}
                  </ul>
                </Block>
              )}
              {lesson.quizQuestions.length > 0 && (
                <Block title={`${lesson.quizQuestions.length} practice questions`}>
                  <ul className="space-y-2.5">
                    {lesson.quizQuestions.map((q, i) => (
                      <li key={i}>
                        <p className="text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
                          {q.question}
                        </p>
                        <ol className="mt-1 space-y-0.5">
                          {q.options.map((o, j) => (
                            <li
                              key={j}
                              className={`text-xs ${j === q.correctIndex
                                ? 'font-medium text-emerald-600 dark:text-emerald-400'
                                : 'text-text-secondary-light dark:text-text-secondary-dark'}`}
                            >
                              {String.fromCharCode(65 + j)}. {o}
                            </li>
                          ))}
                        </ol>
                      </li>
                    ))}
                  </ul>
                </Block>
              )}
              <Provenance provider={providerFor('lesson_followup')} />
            </Card>
          ) : (
            <GenerateCard
              title="Lesson follow-up"
              body="Revision points and practice questions from what was actually taught."
              disabled={!canUseAi || transcript.length < 5}
              busy={generating === 'lesson_followup'}
              onGenerate={() => void generate('lesson_followup', () => meetApi.aiLessonFollowUp(id))}
            />
          )}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

const Block: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section>
    <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">
      {title}
    </h3>
    {children}
  </section>
);

const Provenance: React.FC<{ provider: string | null }> = ({ provider }) => (
  <p className="border-t border-border-light pt-2 text-[11px] text-text-secondary-light/70 dark:border-border-dark/30 dark:text-text-secondary-dark/70">
    Generated{provider ? ` by ${provider}` : ''} from the meeting transcript · check anything you plan to act on
  </p>
);

const GenerateCard: React.FC<{
  title: string; body: string; disabled: boolean; busy: boolean; onGenerate: () => void;
}> = ({ title, body, disabled, busy, onGenerate }) => (
  <Card className="p-5 text-center">
    <Sparkles size={20} className="mx-auto text-blue-500" />
    <h2 className="mt-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">{title}</h2>
    <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-text-secondary-light dark:text-text-secondary-dark">
      {body}
    </p>
    <Button size="sm" className="mt-3" disabled={disabled || busy} onClick={onGenerate}>
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
      Generate
    </Button>
  </Card>
);

/** Where the meeting stands, said once, at the top. */
const StatusChip: React.FC<{ status: string }> = ({ status }) => {
  const tone =
    status === 'live'
      ? 'bg-red-500/15 text-red-600 dark:text-red-300'
      : status === 'scheduled'
        ? 'bg-blue-500/15 text-blue-600 dark:text-blue-300'
        : status === 'cancelled'
          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
          : 'bg-slate-500/15 text-text-secondary-light dark:text-text-secondary-dark';
  const label =
    status === 'live' ? 'Live'
      : status === 'scheduled' ? 'Upcoming'
      : status === 'cancelled' ? 'Cancelled'
      : 'Ended';
  return (
    <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}>
      {status === 'live' && (
        <span className="tupo-live-dot h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
      )}
      {label}
    </span>
  );
};
