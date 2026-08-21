import React, { useEffect, useState } from 'react';
import { AlertTriangle, Info, Lock, Loader2, ShieldAlert, Unlock } from 'lucide-react';
import {
  MEET_ADMISSION_POLICIES, ADMISSION_POLICY_LABELS, ADMISSION_POLICY_HINTS,
} from '@tupo/shared';
import type { HostCommand, MeetAdmissionPolicy, MeetSettings } from '@tupo/shared';
import { PanelShell, PanelToggle, PanelButton } from './Shell';
import * as meetApi from '../api';

/**
 * The host console.
 *
 * This is the direct analogue of TaskMentor's `LiveProctoringDashboard`, and
 * for the same reason: the person running a session needs one place that shows
 * what is going wrong *right now* — who dropped, who was removed, when
 * recording started — rather than reconstructing it afterwards from a log
 * nobody reads. The event stream underneath is literally the same shape.
 */

export interface HostConsoleProps {
  meetingId: string;
  settings: MeetSettings;
  canRecord: boolean;
  canUseAi: boolean;
  canTranscribe: boolean;
  onClose: () => void;
  onCommand: (command: HostCommand) => void;
  onPatchSettings: (patch: Partial<MeetSettings>) => void;
}

interface EventRow {
  id: string;
  type: string;
  severity: string;
  created_at: string;
  display_name: string | null;
  payload: Record<string, unknown>;
}

const SEVERITY_STYLE: Record<string, { Icon: typeof Info; className: string }> = {
  info: { Icon: Info, className: 'text-white/40' },
  warn: { Icon: AlertTriangle, className: 'text-amber-400' },
  critical: { Icon: ShieldAlert, className: 'text-red-400' },
};

/** Event types are machine names; this is what a teacher should read. */
const EVENT_LABEL: Record<string, string> = {
  'participant.joined': 'joined',
  'participant.left': 'left',
  'participant.knocked': 'asked to join',
  'participant.admitted': 'was admitted',
  'participant.denied': 'was denied',
  'participant.removed': 'was removed',
  'participant.promoted': 'was made a co-host',
  'participant.demoted': 'is no longer a co-host',
  'media.muted': 'muted',
  'media.unmuted': 'unmuted',
  'share.started': 'started sharing',
  'share.stopped': 'stopped sharing',
  'recording.started': 'started recording',
  'recording.stopped': 'stopped recording',
  'transcription.started': 'turned captions on',
  'transcription.stopped': 'turned captions off',
  'ai.invited': 'invited Tupo AI',
  'ai.dismissed': 'dismissed Tupo AI',
  'network.degraded': 'has a poor connection',
  'network.recovered': 'reconnected cleanly',
  'network.dropped': 'lost their connection',
  'meeting.locked': 'locked the meeting',
  'meeting.unlocked': 'unlocked the meeting',
  'hand.raised': 'raised their hand',
  'hand.lowered': 'lowered their hand',
  'breakout.opened': 'opened breakout rooms',
  'breakout.closed': 'closed breakout rooms',
  'poll.opened': 'started a poll',
  'poll.closed': 'closed a poll',
};

export const HostConsole: React.FC<HostConsoleProps> = ({
  meetingId, settings, canRecord, canUseAi, canTranscribe, onClose, onCommand, onPatchSettings,
}) => {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [loading, setLoading] = useState(true);

  // Polled rather than pushed. The console is a diagnostic surface, not a
  // realtime one, and a five-second refresh is far cheaper than fanning every
  // mute and unmute in a thirty-person meeting to every host's socket.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await meetApi.getEvents(meetingId);
        if (!cancelled) setEvents(rows as EventRow[]);
      } catch {
        // A failed poll is not worth an error state; the next one will do.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [meetingId]);

  const shown = onlyProblems ? events.filter((e) => e.severity !== 'info') : events;

  return (
    <PanelShell
      title="Host controls"
      subtitle="Settings, and what has happened in this meeting"
      onClose={onClose}
      footer={
        <PanelButton
          variant={settings.locked ? 'danger' : 'ghost'}
          className="w-full"
          onClick={() => onCommand({ action: settings.locked ? 'unlock' : 'lock' })}
        >
          {settings.locked ? <><Unlock size={13} /> Unlock the meeting</> : <><Lock size={13} /> Lock the meeting</>}
        </PanelButton>
      }
    >
      <section className="border-b border-white/10 py-2">
        <h3 className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">
          Who can do what
        </h3>
        <PanelToggle
          label="Attendees can chat"
          checked={settings.allowChat}
          onChange={(v) => onCommand({ action: v ? 'enable_chat' : 'disable_chat' })}
        />
        <PanelToggle
          label="Attendees can share their screen"
          checked={settings.allowScreenShare}
          onChange={(v) => onCommand({ action: v ? 'enable_share' : 'disable_share' })}
        />
        <PanelToggle
          label="Attendees can unmute themselves"
          hint="Off means only you can invite someone to speak."
          checked={settings.allowAttendeeUnmute}
          onChange={(v) => onPatchSettings({ allowAttendeeUnmute: v })}
        />
        <PanelToggle
          label="Attendees can react"
          checked={settings.allowReactions}
          onChange={(v) => onPatchSettings({ allowReactions: v })}
        />
      </section>

      <section className="border-b border-white/10 py-2">
        <h3 className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">
          Admission
        </h3>
        <PanelToggle
          label="Waiting room"
          hint="People you have not invited knock before entering."
          checked={settings.lobbyEnabled}
          onChange={(v) => onPatchSettings({ lobbyEnabled: v })}
        />
        <div className="px-4 py-2">
          <span className="mb-1.5 block text-xs text-white/60">Who can join</span>
          <select
            value={settings.admissionPolicy}
            onChange={(e) =>
              onPatchSettings({ admissionPolicy: e.target.value as MeetAdmissionPolicy })}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-sm text-white focus:border-blue-500 focus:outline-none [&>option]:bg-slate-800"
          >
            {MEET_ADMISSION_POLICIES.map((value) => (
              <option key={value} value={value}>{ADMISSION_POLICY_LABELS[value]}</option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] leading-relaxed text-white/40">
            {ADMISSION_POLICY_HINTS[settings.admissionPolicy]}
          </span>
          {settings.admissionPolicy === 'public' && (
            <span className="mt-1.5 block text-[11px] leading-relaxed text-amber-300/80">
              Anyone with the link can ask to join. They always wait in the lobby.
            </span>
          )}
        </div>
      </section>

      <section className="border-b border-white/10 py-2">
        <h3 className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">
          Record & transcribe
        </h3>
        <PanelToggle
          label="Allow recording"
          hint={canRecord ? 'Everyone is told for as long as it runs.' : 'You do not have permission to record.'}
          checked={settings.recordingEnabled}
          disabled={!canRecord}
          onChange={(v) => onPatchSettings({ recordingEnabled: v })}
        />
        <PanelToggle
          label="Live captions and transcript"
          hint={canTranscribe
            ? 'Each person transcribes their own microphone in their browser.'
            : 'You do not have permission to enable transcription.'}
          checked={settings.transcriptionEnabled}
          disabled={!canTranscribe}
          onChange={(v) => onPatchSettings({ transcriptionEnabled: v })}
        />
        <PanelToggle
          label="Tupo AI notetaker"
          hint={canUseAi ? 'Needs captions on. Reads the transcript, never the audio.' : 'You do not have permission to use AI.'}
          checked={settings.aiAssistantEnabled}
          disabled={!canUseAi || !settings.transcriptionEnabled}
          onChange={(v) => onPatchSettings({ aiAssistantEnabled: v })}
        />
        <PanelToggle
          label="Minutes when the meeting ends"
          checked={settings.aiPostMeetingMinutes}
          disabled={!settings.aiAssistantEnabled}
          onChange={(v) => onPatchSettings({ aiPostMeetingMinutes: v })}
        />
        <PanelToggle
          label="Participation report"
          hint="Talk-time balance and who never spoke, for the lesson record."
          checked={settings.aiEngagementReport}
          disabled={!settings.aiAssistantEnabled}
          onChange={(v) => onPatchSettings({ aiEngagementReport: v })}
        />
        <PanelToggle
          label="Lesson follow-up"
          hint="Revision points and practice questions from what was taught."
          checked={settings.aiLessonFollowUp}
          disabled={!settings.aiAssistantEnabled}
          onChange={(v) => onPatchSettings({ aiLessonFollowUp: v })}
        />
      </section>

      <section className="py-2">
        <div className="flex items-center justify-between px-4 py-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-white/40">
            Activity
          </h3>
          <button
            onClick={() => setOnlyProblems((o) => !o)}
            className={`text-[11px] ${onlyProblems ? 'text-amber-300' : 'text-white/40 hover:text-white/70'}`}
          >
            {onlyProblems ? 'Showing problems' : 'Show problems only'}
          </button>
        </div>

        {loading ? (
          <div className="grid place-items-center py-6">
            <Loader2 size={16} className="animate-spin text-white/30" />
          </div>
        ) : shown.length === 0 ? (
          <p className="px-4 py-4 text-xs text-white/40">
            {onlyProblems ? 'Nothing has gone wrong.' : 'Nothing has happened yet.'}
          </p>
        ) : (
          <ul className="space-y-0.5 px-2">
            {shown.map((e) => {
              const { Icon, className } = SEVERITY_STYLE[e.severity] ?? SEVERITY_STYLE.info!;
              return (
                <li key={e.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
                  <Icon size={12} className={`mt-0.5 shrink-0 ${className}`} />
                  <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-white/70">
                    <span className="font-medium text-white/90">{e.display_name ?? 'Someone'}</span>{' '}
                    {EVENT_LABEL[e.type] ?? e.type}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-white/30">
                    {new Date(e.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </PanelShell>
  );
};
