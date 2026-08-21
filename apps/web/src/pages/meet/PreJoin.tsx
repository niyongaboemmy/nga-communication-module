import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CameraOff,
  Check,
  ChevronDown,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  Pencil,
  Share2,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import { Avatar } from '../../components/ui';
import { useDevices, applySpeaker } from './useDevices';
import { ShareMeeting } from './ShareMeeting';

/**
 * The device check (FR-MEET-4).
 *
 * Nobody should discover their microphone is muted at the operating-system
 * level thirty seconds into a lesson. So this screen is not a formality: it
 * shows a live camera preview, a real level meter fed by the actual capture,
 * and a speaker test — and it is where "join muted" is decided, before anyone
 * else can hear the room.
 */

export interface PreJoinProps {
  title: string;
  hostName?: string;
  participantCount?: number;
  joinLabel?: string;
  /** True when the meeting has a waiting room and this user is not invited. */
  willKnock?: boolean;
  busy?: boolean;
  error?: string | null;
  yourName: string;
  yourAvatar?: string | null;
  onJoin: (opts: {
    stream: MediaStream | null;
    micEnabled: boolean;
    cameraEnabled: boolean;
    speakerId: string;
  }) => void;
  onCancel: () => void;

  /* Everything below is what the *host* can do from here. The device check is
     the last screen before a meeting starts, which makes it the natural place
     to fix the name, send the link, or call the whole thing off — all of which
     previously meant joining first and then undoing it. */
  meetingId?: string;
  joinCode?: string;
  admission?: 'invited' | 'permission' | 'authenticated' | 'public';
  canRename?: boolean;
  canEnd?: boolean;
  /** 'cancel' for a meeting that has not started, 'end' for one already live. */
  endLabel?: 'cancel' | 'end';
  onRename?: (title: string) => Promise<void>;
  onEndMeeting?: () => Promise<void>;
}

/** A short tone, generated rather than fetched — no asset, no network. */
function playTestTone(deviceId: string): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    osc.type = 'sine';
    // A raw square-edged tone at full gain is unpleasant on headphones; ramp it.
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.05);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.65);
    setTimeout(() => void ctx.close().catch(() => {}), 800);
    void deviceId; // Output routing is applied to media elements, not AudioContext.
  } catch {
    // No audio context available; the picker still works.
  }
}

export const PreJoin: React.FC<PreJoinProps> = ({
  title,
  hostName,
  participantCount,
  joinLabel,
  willKnock,
  busy,
  error,
  yourName,
  yourAvatar,
  onJoin,
  onCancel,
  meetingId,
  joinCode,
  admission,
  canRename,
  canEnd,
  endLabel = 'cancel',
  onRename,
  onEndMeeting,
}) => {
  const devices = useDevices();
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [savingTitle, setSavingTitle] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);

  /* The microphone test.
   *
   * A level meter proves the microphone is *capturing*; it says nothing about
   * whether the result is audible, or whether the right device is selected —
   * a laptop lid meter twitches happily while everyone hears a keyboard. The
   * only test that answers the real question is hearing yourself back. */
  type MicTest = 'idle' | 'recording' | 'playing';
  const [micTest, setMicTest] = useState<MicTest>('idle');
  const [countdown, setCountdown] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const playbackRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => { setDraftTitle(title); }, [title]);

  // Anything still running when this screen goes away must be stopped, or the
  // recording keeps going into a meeting nobody knows is being recorded.
  useEffect(() => () => {
    try { recorderRef.current?.stop(); } catch { /* already stopped */ }
    playbackRef.current?.pause();
  }, []);

  const RECORD_SECONDS = 4;

  const runMicTest = () => {
    const stream = devices.stream;
    const track = stream?.getAudioTracks()[0];
    if (!stream || !track || micTest !== 'idle') return;

    const chunks: Blob[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(new MediaStream([track]));
    } catch {
      return;   // No MediaRecorder here; the level meter is still the fallback.
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const url = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
      const audio = new Audio(url);
      playbackRef.current = audio;
      // Play it back through the speaker actually chosen above, so the test
      // covers the output device too.
      void applySpeaker(audio, devices.speakerId);
      audio.onended = () => { setMicTest('idle'); URL.revokeObjectURL(url); };
      setMicTest('playing');
      void audio.play().catch(() => { setMicTest('idle'); URL.revokeObjectURL(url); });
    };

    recorder.start();
    setMicTest('recording');
    setCountdown(RECORD_SECONDS);

    const tick = window.setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          window.clearInterval(tick);
          try { recorder.stop(); } catch { /* already stopped */ }
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  };

  const commitRename = async () => {
    const next = draftTitle.trim();
    if (!onRename || !next || next === title) { setRenaming(false); setDraftTitle(title); return; }
    setSavingTitle(true);
    try { await onRename(next); setRenaming(false); }
    catch { setDraftTitle(title); }
    finally { setSavingTitle(false); }
  };

  // Open the preview once on mount; the picker effects below handle changes.
  useEffect(() => {
    void devices.open(); /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  useEffect(() => {
    if (devices.ready) void devices.open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices.cameraId, devices.microphoneId]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = devices.stream;
      void videoRef.current.play().catch(() => {});
    }
  }, [devices.stream]);

  // Toggling here only flips `enabled`. The tracks stay open so the preview
  // keeps working and joining does not have to reopen the camera.
  useEffect(() => {
    for (const t of devices.stream?.getAudioTracks() ?? []) t.enabled = micOn;
  }, [micOn, devices.stream]);

  useEffect(() => {
    for (const t of devices.stream?.getVideoTracks() ?? []) t.enabled = cameraOn;
  }, [cameraOn, devices.stream]);

  const join = () => {
    onJoin({
      // detach() hands the live stream to the call — reopening the camera
      // between here and the room is a visible, avoidable stall.
      stream: devices.detach(),
      micEnabled: micOn,
      cameraEnabled: cameraOn,
      speakerId: devices.speakerId,
    });
  };

  return (
    <div className="tupo-aurora tupo-aurora-on-dark grid min-h-full place-items-center bg-slate-950 p-4">
      <div className="tupo-glass tupo-sheen w-full max-w-4xl rounded-3xl p-5 sm:p-6">
        <div className="mb-5 text-center">
          {renaming ? (
            <span className="mx-auto flex max-w-sm items-center gap-1.5">
              <input
                value={draftTitle}
                autoFocus
                maxLength={200}
                onChange={(e) => setDraftTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename();
                  if (e.key === 'Escape') { setRenaming(false); setDraftTitle(title); }
                }}
                aria-label="Meeting name"
                className="min-w-0 flex-1 rounded-lg border border-blue-500 bg-white/5 px-2.5 py-1.5 text-center text-lg font-semibold text-white focus:outline-none"
              />
              <button
                onClick={() => void commitRename()}
                disabled={savingTitle}
                aria-label="Save the name"
                className="grid h-8 w-8 place-items-center rounded-full text-emerald-400 hover:bg-white/10"
              >
                {savingTitle ? <Loader2 size={14} className="animate-spin" /> : <Check size={15} />}
              </button>
              <button
                onClick={() => { setRenaming(false); setDraftTitle(title); }}
                aria-label="Cancel renaming"
                className="grid h-8 w-8 place-items-center rounded-full text-white/40 hover:bg-white/10 hover:text-white"
              >
                <X size={15} />
              </button>
            </span>
          ) : (
            <span className="group inline-flex items-center gap-1.5">
              <h1 className="text-xl font-semibold tracking-tight text-white">{title}</h1>
              {canRename && onRename && (
                <button
                  onClick={() => setRenaming(true)}
                  aria-label="Rename this meeting"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/30 opacity-0 transition-opacity duration-150 hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Pencil size={13} />
                </button>
              )}
            </span>
          )}
          <p className="mt-1 text-sm text-white/50">
            {hostName ? `Hosted by ${hostName}` : 'Check your camera and microphone before joining'}
            {typeof participantCount === 'number' &&
              participantCount > 0 &&
              ` · ${participantCount} already here`}
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-[1.4fr_1fr]">
          {/* Preview */}
          <div>
            <div className="relative aspect-video overflow-hidden rounded-2xl bg-slate-900 ring-1 ring-white/10">
              {devices.stream && cameraOn ? (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="h-full w-full scale-x-[-1] object-cover"
                />
              ) : (
                <div className="grid h-full place-items-center">
                  {devices.ready ? (
                    <Avatar name={yourName} src={yourAvatar ?? undefined} size={80} />
                  ) : (
                    <Loader2 size={24} className="animate-spin text-white/30" />
                  )}
                </div>
              )}

              {/* Level meter, over the preview so both are in one glance. */}
              <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-3 py-2.5">
                <span className="shrink-0 text-white/70">
                  {micOn ? <Mic size={15} /> : <MicOff size={15} className="text-red-400" />}
                </span>
                <LevelMeter level={micOn ? devices.level : 0} />
                <span className="shrink-0 text-[11px] text-white/50">
                  {!micOn ? 'Muted' : devices.level > 0.04 ? 'We can hear you' : 'Say something'}
                </span>
              </div>
            </div>

            <div className="mt-4 flex justify-center gap-2.5">
              <DeviceToggle
                on={micOn}
                onClick={() => setMicOn((m) => !m)}
                label={micOn ? 'Turn microphone off' : 'Turn microphone on'}
                OnIcon={Mic}
                OffIcon={MicOff}
              />
              <DeviceToggle
                on={cameraOn}
                onClick={() => setCameraOn((c) => !c)}
                label={cameraOn ? 'Turn camera off' : 'Turn camera on'}
                OnIcon={Camera}
                OffIcon={CameraOff}
              />
            </div>
          </div>

          {/* Devices */}
          <div className="space-y-3">
            {(devices.error || error) && (
              <div className="flex gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3">
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-300" />
                <p className="text-xs leading-relaxed text-amber-100/90">{error ?? devices.error}</p>
              </div>
            )}

            <Picker
              Icon={Camera}
              label="Camera"
              value={devices.cameraId}
              options={devices.cameras}
              onChange={devices.setCameraId}
            />
            <Picker
              Icon={Mic}
              label="Microphone"
              value={devices.microphoneId}
              options={devices.microphones}
              onChange={devices.setMicrophoneId}
            />
            {devices.speakers.length > 0 && (
              <div>
                <Picker
                  Icon={Volume2}
                  label="Speaker"
                  value={devices.speakerId}
                  options={devices.speakers}
                  onChange={devices.setSpeakerId}
                />

              </div>
            )}

            {/* The two checks, given equal weight and put together.
                One was a full-width button and the other a text link tucked
                under a picker, which made them look like different kinds of
                thing when they answer the same question: will this work? */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={runMicTest}
                disabled={micTest !== 'idle' || !devices.stream}
                className={
                  'flex items-center justify-center gap-1.5 rounded-full border px-2 py-2 text-xs font-medium transition-colors duration-150 ' +
                  (micTest === 'recording'
                    ? 'border-red-400/50 bg-red-500/15 text-red-200'
                    : micTest === 'playing'
                      ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200'
                      : 'border-white/10 text-white/70 hover:border-white/25 hover:bg-white/5 disabled:opacity-40')
                }
              >
                {micTest === 'recording' ? (
                  <><span className="tupo-live-dot h-1.5 w-1.5 rounded-full bg-red-400" /> Recording {countdown}s</>
                ) : micTest === 'playing' ? (
                  <><Volume2 size={13} /> Playing…</>
                ) : (
                  <><Mic size={13} /> Test mic</>
                )}
              </button>

              <button
                type="button"
                onClick={() => playTestTone(devices.speakerId)}
                className="flex items-center justify-center gap-1.5 rounded-full border border-white/10 px-2 py-2 text-xs font-medium text-white/70 transition-colors duration-150 hover:border-white/25 hover:bg-white/5"
              >
                <Volume2 size={13} /> Test sound
              </button>
            </div>

            {(canRename || meetingId || canEnd) && (
              <div className="flex flex-wrap gap-1.5 border-t border-white/10 pt-3">
                {meetingId && joinCode && (
                  <HostAction icon={<Share2 size={13} />} onClick={() => setSharing(true)}>
                    Share
                  </HostAction>
                )}
                {canEnd && onEndMeeting && (
                  <HostAction
                    icon={<Trash2 size={13} />}
                    danger
                    onClick={() => setConfirmEnd(true)}
                  >
                    {endLabel === 'end' ? 'End meeting' : 'Cancel meeting'}
                  </HostAction>
                )}
              </div>
            )}

            {/* Said once, plainly. Everything above is a control; this is the
                answer they add up to. */}
            <p className="flex items-center gap-1.5 text-[11px] text-white/45">
              {devices.ready && (micOn || cameraOn) ? (
                <>
                  <Check size={12} className="text-emerald-400" />
                  {micOn && cameraOn ? 'Camera and microphone ready'
                    : micOn ? 'Microphone ready — camera off'
                    : 'Camera ready — microphone off'}
                </>
              ) : devices.ready ? (
                <>
                  <MicOff size={12} className="text-white/40" />
                  Joining with both off — you can turn them on inside
                </>
              ) : (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Checking your devices…
                </>
              )}
            </p>

            <div className="space-y-2 pt-1">
              <button
                onClick={join}
                disabled={busy || !devices.ready}
                className="tupo-lift flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 hover:bg-blue-500 px-4 py-3 text-sm font-semibold text-white transition-colors duration-150 disabled:opacity-40 disabled:hover:translate-y-0"
              >
                {busy && <Loader2 size={15} className="animate-spin" />}
                {joinLabel ?? (willKnock ? 'Ask to join' : 'Join now')}
              </button>
              <button
                onClick={onCancel}
                className="w-full rounded-full px-4 py-2 text-sm text-white/50 transition-colors duration-150 hover:bg-white/5 hover:text-white/80"
              >
                Cancel
              </button>
            </div>

            {sharing && meetingId && joinCode && (
              <ShareMeeting
                meetingId={meetingId}
                joinCode={joinCode}
                title={title}
                admission={admission}
                onClose={() => setSharing(false)}
              />
            )}

            {confirmEnd && onEndMeeting && (
              <div
                role="dialog"
                aria-modal="true"
                aria-label={endLabel === 'end' ? 'End this meeting' : 'Cancel this meeting'}
                className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
                onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmEnd(false); }}
              >
                <div className="animate-pop w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-4">
                  <h2 className="text-sm font-semibold text-white">
                    {endLabel === 'end' ? 'End this meeting for everyone?' : 'Cancel this meeting?'}
                  </h2>
                  <p className="mt-1 text-xs leading-relaxed text-white/60">
                    {endLabel === 'end'
                      ? 'Everyone still in it will be returned to the summary. This cannot be undone.'
                      : 'Nobody will be able to join. Anyone invited keeps the entry in their list, marked cancelled.'}
                  </p>
                  <div className="mt-4 flex gap-2">
                    <button
                      onClick={() => setConfirmEnd(false)}
                      className="flex-1 rounded-full border border-white/10 px-3 py-2 text-sm text-white/70 hover:bg-white/5"
                    >
                      Keep it
                    </button>
                    <button
                      onClick={async () => {
                        setEnding(true);
                        try { await onEndMeeting(); } finally { setEnding(false); setConfirmEnd(false); }
                      }}
                      disabled={ending}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                    >
                      {ending && <Loader2 size={14} className="animate-spin" />}
                      {endLabel === 'end' ? 'End it' : 'Cancel it'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {willKnock && (
              <p className="text-[11px] leading-relaxed text-white/40">
                <Monitor size={11} className="mr-1 inline" />
                This meeting has a waiting room. The host will be asked to let you in.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const Picker: React.FC<{
  Icon: typeof Camera;
  label: string;
  value: string;
  options: Array<{ deviceId: string; label: string }>;
  onChange: (id: string) => void;
}> = ({ Icon, label, value, options, onChange }) => (
  <label className="block">
    <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-white/60">
      <Icon size={12} /> {label}
    </span>
    <span className="relative block">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={options.length === 0}
        className="w-full appearance-none rounded-xl border border-white/10 bg-white/5 py-2.5 pl-3 pr-9 text-sm text-white transition-colors duration-150 hover:border-white/20 hover:bg-white/[0.08] focus:border-blue-500/60 focus:bg-white/[0.08] focus:outline-none focus:ring-2 focus:ring-blue-500/25 disabled:opacity-40 [&>option]:bg-slate-800"
      >
        {options.length === 0 ? (
          <option value="">No {label.toLowerCase()} found</option>
        ) : (
          <>
            <option value="">System default</option>
            {options.map((o) => (
              <option key={o.deviceId} value={o.deviceId}>
                {o.label}
              </option>
            ))}
          </>
        )}
      </select>
      {/* The native arrow is the single most dated thing on this screen, and
 it cannot be styled — so it is suppressed and drawn here instead. */}
      <ChevronDown
        size={15}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/40"
      />
    </span>
  </label>
);

/**
 * A segmented level meter.
 *
 * A continuous bar at speaking volume sits near the left edge and reads as
 * broken. Discrete segments read as "one lit, working" at exactly the same
 * input, which is the thing this screen exists to answer.
 */
const METER_SEGMENTS = 12;

const LevelMeter: React.FC<{ level: number }> = ({ level }) => {
  const lit = Math.round(Math.min(1, level) * METER_SEGMENTS);
  return (
    <span className="flex flex-1 items-center gap-[3px]" aria-hidden="true">
      {Array.from({ length: METER_SEGMENTS }, (_, i) => (
        <span
          key={i}
          className={
            'tupo-meter-seg h-2 flex-1 rounded-full ' +
            (i < lit
              ? // The top two segments are amber: that is the clipping range,
                // and seeing it is how someone knows to back off the mic.
                i >= METER_SEGMENTS - 2
                ? 'bg-amber-400'
                : 'bg-emerald-400'
              : 'bg-white/15')
          }
        />
      ))}
    </span>
  );
};

/** Mic and camera, where the *off* state is the one worth shouting about. */
const DeviceToggle: React.FC<{
  on: boolean;
  label: string;
  onClick: () => void;
  OnIcon: typeof Mic;
  OffIcon: typeof MicOff;
}> = ({ on, label, onClick, OnIcon, OffIcon }) => (
  <button
    onClick={onClick}
    aria-pressed={on}
    aria-label={label}
    title={label}
    className={
      'tupo-press grid h-12 w-12 place-items-center rounded-full ring-1 transition-colors duration-150 ' +
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ' +
      (on
        ? 'bg-white/10 text-white ring-white/15 hover:bg-white/20'
        : 'bg-red-600 text-white ring-red-400/40 hover:bg-red-500')
    }
  >
    {on ? <OnIcon size={20} /> : <OffIcon size={20} />}
  </button>
);

/** A small, low-emphasis control: these are host chores, not the main event. */
const HostAction: React.FC<{
  icon: React.ReactNode; danger?: boolean; onClick: () => void; children: React.ReactNode;
}> = ({ icon, danger, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={
      'flex flex-1 items-center justify-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium ' +
      'transition-colors duration-150 ' +
      (danger
        ? 'border-red-500/25 text-red-300 hover:border-red-500/50 hover:bg-red-500/10'
        : 'border-white/10 text-white/70 hover:border-white/25 hover:bg-white/5 hover:text-white')
    }
  >
    {icon}{children}
  </button>
);

export { applySpeaker };
