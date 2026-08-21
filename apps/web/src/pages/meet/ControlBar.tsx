import React, { useEffect, useRef, useState } from 'react';
import {
  Captions,
  ChevronUp,
  Circle,
  Gauge,
  Hand,
  LayoutGrid,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  MoreHorizontal,
  PhoneOff,
  Rows3,
  Settings,
  Smile,
  Sparkles,
  SquareUser,
  Users,
  Video,
  VideoOff,
  HelpCircle,
  BarChart3,
  DoorOpen,
  NotebookPen,
  Volume2,
  VolumeX,
  MessageCircleMore,
  MicVocal,
} from 'lucide-react';
import { PresentPicker } from './PresentationBar';
import { useNotify } from '../../context/NotificationContext';
import { MEET_REACTIONS } from '@tupo/shared';
import type { MeetLayout, MeetReaction } from '@tupo/shared';

/**
 * The in-meeting control bar.
 *
 * Ordering is deliberate and matches what people already have in their hands:
 * microphone and camera first and always visible, leave hard right and
 * unmistakably red, everything else in the middle. On a phone the middle
 * collapses into an overflow sheet rather than shrinking below a 44px target.
 */

export type PanelKey =
  'participants' | 'chat' | 'captions' | 'ai' | 'notes' | 'polls' | 'qa' | 'breakouts' | 'settings' | 'host';

export interface ControlBarProps {
  micEnabled: boolean;
  cameraEnabled: boolean;
  screenSharing: boolean;
  handRaised: boolean;
  recording: boolean;
  captionsOn: boolean;
  captionsSupported: boolean;
  dataSaver: boolean;
  layout: MeetLayout;
  isHost: boolean;
  canShare: boolean;
  canRecord: boolean;
  canUseAi: boolean;
  aiPresent: boolean;
  participantCount: number;
  lobbyCount: number;
  unreadChat: number;
  noteCount: number;
  openPanel: PanelKey | null;

  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleShare: () => void;
  onStartShare: (opts: { preferSurface?: 'monitor' | 'window' | 'browser'; withAudio?: boolean }) => void;
  onToggleHand: () => void;
  onReact: (reaction: MeetReaction) => void;
  onToggleCaptions: () => void;
  onToggleDataSaver: () => void;
  onToggleRecording: () => void;
  onSetLayout: (layout: MeetLayout) => void;
  onOpenPanel: (panel: PanelKey | null) => void;
  onLeave: () => void;
  onEndForAll?: () => void;
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

const Control: React.FC<{
  label: string;
  active?: boolean;
  danger?: boolean;
  badge?: number;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, active, danger, badge, onClick, children }) => (
  <button
    onClick={onClick}
    title={label}
    aria-label={label}
    aria-pressed={active}
    className={
      'tupo-press relative grid h-11 w-11 shrink-0 place-items-center rounded-full ' +
      'transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ' +
      (danger
        ? 'bg-red-600 text-white hover:bg-red-500'
        : active
          ? 'bg-blue-600 text-white hover:bg-blue-500 '
          : 'bg-white/[0.08] text-white ring-1 ring-white/10 hover:bg-white/20')
    }
  >
    {children}
    {!!badge && badge > 0 && (
      <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white ring-2 ring-slate-950">
        {badge > 99 ? '99+' : badge}
      </span>
    )}
  </button>
);

/** A control whose off state is the alarming one — mic and camera. */
const MediaControl: React.FC<{
  label: string;
  on: boolean;
  onClick: () => void;
  OnIcon: typeof Mic;
  OffIcon: typeof MicOff;
}> = ({ label, on, onClick, OnIcon, OffIcon }) => (
  <button
    onClick={onClick}
    title={label}
    aria-label={label}
    aria-pressed={on}
    className={
      'tupo-press grid h-11 w-11 shrink-0 place-items-center rounded-full ' +
      'transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ' +
      (on
        ? 'bg-white/[0.08] text-white ring-1 ring-white/10 hover:bg-white/20'
        : 'bg-red-600 text-white ring-1 ring-red-400/40 hover:bg-red-500')
    }
  >
    {on ? <OnIcon size={19} /> : <OffIcon size={19} />}
  </button>
);

function useDismiss(onDismiss: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onDismiss]);
  return ref;
}

const Popover: React.FC<{ onClose: () => void; children: React.ReactNode }> = ({ onClose, children }) => {
  const ref = useDismiss(onClose);
  return (
    <div
      ref={ref}
      className="tupo-glass tupo-sheen animate-pop absolute bottom-full left-1/2 z-50 mb-3 -translate-x-1/2 rounded-2xl p-2"
    >
      {children}
    </div>
  );
};

const LAYOUTS: Array<{ key: MeetLayout; label: string; Icon: typeof LayoutGrid }> = [
  { key: 'grid', label: 'Grid', Icon: LayoutGrid },
  { key: 'speaker', label: 'Speaker', Icon: SquareUser },
  { key: 'sidebar', label: 'Sidebar', Icon: Rows3 },
  { key: 'spotlight', label: 'Spotlight', Icon: Circle },
];

/* ------------------------------------------------------------------ *
 * Bar
 * ------------------------------------------------------------------ */

export const ControlBar: React.FC<ControlBarProps> = (p) => {
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [presentOpen, setPresentOpen] = useState(false);
  const { soundOn, setSoundOn, voiceOn, setVoiceOn, voiceSupported } = useNotify();

  const panel = (key: PanelKey) => () => p.onOpenPanel(p.openPanel === key ? null : key);

  return (
    <div className="pb-safe relative flex shrink-0 items-center justify-between gap-2 bg-gradient-to-t from-slate-950 to-slate-950/80 px-2 py-2 backdrop-blur-md sm:px-4 sm:py-3">
      {/* Left — recording state. Not dismissible while it runs (FR-MEET-12). */}
      <div className="hidden min-w-0 flex-1 items-center gap-2 sm:flex">
        {p.recording && (
          <span className="flex items-center gap-1.5 rounded-full bg-red-600/20 px-2.5 py-1 text-xs font-medium text-red-300 ring-1 ring-red-500/30">
            <span className="tupo-live-dot h-2 w-2 rounded-full bg-red-500" />
            Recording
          </span>
        )}
      </div>

      {/* Centre — the controls proper. */}
      <div className="tupo-glass tupo-sheen mx-auto flex items-center justify-center gap-1 rounded-full px-1.5 py-1.5 sm:gap-2 sm:px-2 sm:py-2">
        <MediaControl
          label={p.micEnabled ? 'Mute microphone' : 'Unmute microphone'}
          on={p.micEnabled}
          onClick={p.onToggleMic}
          OnIcon={Mic}
          OffIcon={MicOff}
        />
        <MediaControl
          label={p.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
          on={p.cameraEnabled}
          onClick={p.onToggleCamera}
          OnIcon={Video}
          OffIcon={VideoOff}
        />

        {p.canShare && (
          <div className="relative">
            <Control
              label={p.screenSharing ? 'Stop presenting' : 'Present your screen'}
              active={p.screenSharing || presentOpen}
              onClick={() => {
                // Stopping is one click. Starting offers the source choice
                // first, because "which window did I just share?" is the
                // question people get wrong.
                if (p.screenSharing) p.onToggleShare();
                else setPresentOpen((o) => !o);
              }}
            >
              <MonitorUp size={19} />
            </Control>
            {presentOpen && !p.screenSharing && (
              <PresentPicker onStart={p.onStartShare} onClose={() => setPresentOpen(false)} />
            )}
          </div>
        )}

        <Control
          label={p.handRaised ? 'Lower hand' : 'Raise hand'}
          active={p.handRaised}
          onClick={p.onToggleHand}
        >
          <Hand size={19} />
        </Control>

        <div className="relative">
          <Control label="React" active={reactionsOpen} onClick={() => setReactionsOpen((o) => !o)}>
            <Smile size={19} />
          </Control>
          {reactionsOpen && (
            <Popover onClose={() => setReactionsOpen(false)}>
              <div className="flex gap-1">
                {MEET_REACTIONS.map((r) => (
                  <button
                    key={r}
                    onClick={() => {
                      p.onReact(r);
                      setReactionsOpen(false);
                    }}
                    aria-label={`React with ${r}`}
                    className="grid h-10 w-10 place-items-center rounded-full text-xl transition-transform duration-100 hover:scale-125 hover:bg-white/10"
                  >
                    {r}
                  </button>
                ))}
              </div>
            </Popover>
          )}
        </div>

        {/* Panels — hidden below `sm`, where they move into the overflow sheet. */}
        <span className="hidden items-center gap-1.5 sm:flex sm:gap-2">
          <Control
            label="Participants"
            badge={p.lobbyCount}
            active={p.openPanel === 'participants'}
            onClick={panel('participants')}
          >
            <Users size={19} />
          </Control>
          <Control label="Chat" badge={p.unreadChat} active={p.openPanel === 'chat'} onClick={panel('chat')}>
            <MessageSquare size={19} />
          </Control>
          <Control label="Your notes" active={p.openPanel === 'notes'} onClick={panel('notes')}>
            <NotebookPen size={19} />
          </Control>
          {p.canUseAi && (
            <Control
              label={p.aiPresent ? 'AI notes' : 'Invite the AI notetaker'}
              active={p.openPanel === 'ai'}
              onClick={panel('ai')}
            >
              <Sparkles size={19} className={p.aiPresent ? 'text-blue-300' : undefined} />
            </Control>
          )}
        </span>

        <div className="relative">
          <Control label="More" active={overflowOpen} onClick={() => setOverflowOpen((o) => !o)}>
            <MoreHorizontal size={19} />
          </Control>
          {overflowOpen && (
            <Popover onClose={() => setOverflowOpen(false)}>
              <div className="w-56">
                <SheetItem
                  Icon={Captions}
                  label={p.captionsOn ? 'Turn captions off' : 'Turn captions on'}
                  hint={p.captionsSupported ? undefined : 'Not supported in this browser'}
                  disabled={!p.captionsSupported}
                  active={p.captionsOn}
                  onClick={() => {
                    p.onToggleCaptions();
                    setOverflowOpen(false);
                  }}
                />
                <SheetItem
                  Icon={soundOn ? Volume2 : VolumeX}
                  label={soundOn ? 'Notification sounds on' : 'Notification sounds off'}
                  hint="Chimes for joins, chat, hands and recording"
                  active={soundOn}
                  onClick={() => {
                    setSoundOn(!soundOn);
                    setOverflowOpen(false);
                  }}
                />
                {voiceSupported && (
                  <SheetItem
                    Icon={voiceOn ? MicVocal : MessageCircleMore}
                    label={voiceOn ? 'Spoken notifications on' : 'Read notifications aloud'}
                    hint="Says who joined, who has a question, when recording starts"
                    active={voiceOn}
                    onClick={() => {
                      setVoiceOn(!voiceOn);
                      setOverflowOpen(false);
                    }}
                  />
                )}
                <SheetItem
                  Icon={Gauge}
                  label={p.dataSaver ? 'Data saver on' : 'Turn on data saver'}
                  hint="Lower video quality, fewer video tiles"
                  active={p.dataSaver}
                  onClick={() => {
                    p.onToggleDataSaver();
                    setOverflowOpen(false);
                  }}
                />
                <SheetItem
                  Icon={NotebookPen}
                  label="Your notes"
                  hint={p.noteCount ? `${p.noteCount} saved` : 'Private until you share one'}
                  active={p.openPanel === 'notes'}
                  onClick={() => {
                    panel('notes')();
                    setOverflowOpen(false);
                  }}
                />
                <SheetItem
                  Icon={HelpCircle}
                  label="Questions"
                  active={p.openPanel === 'qa'}
                  onClick={() => {
                    panel('qa')();
                    setOverflowOpen(false);
                  }}
                />
                <SheetItem
                  Icon={BarChart3}
                  label="Polls"
                  active={p.openPanel === 'polls'}
                  onClick={() => {
                    panel('polls')();
                    setOverflowOpen(false);
                  }}
                />
                {p.isHost && (
                  <>
                    <div className="my-1 h-px bg-white/10" />
                    <SheetItem
                      Icon={DoorOpen}
                      label="Breakout rooms"
                      active={p.openPanel === 'breakouts'}
                      onClick={() => {
                        panel('breakouts')();
                        setOverflowOpen(false);
                      }}
                    />
                    <SheetItem
                      Icon={Settings}
                      label="Host controls"
                      active={p.openPanel === 'host'}
                      onClick={() => {
                        panel('host')();
                        setOverflowOpen(false);
                      }}
                    />
                    {p.canRecord && (
                      <SheetItem
                        Icon={Circle}
                        label={p.recording ? 'Stop recording' : 'Start recording'}
                        hint={p.recording ? undefined : 'Everyone is told while it runs'}
                        active={p.recording}
                        onClick={() => {
                          p.onToggleRecording();
                          setOverflowOpen(false);
                        }}
                      />
                    )}
                  </>
                )}
                {/* Duplicated here because the panel controls are hidden below `sm`. */}
                <div className="my-1 h-px bg-white/10 sm:hidden" />
                <span className="sm:hidden">
                  <SheetItem
                    Icon={Users}
                    label="Participants"
                    onClick={() => {
                      panel('participants')();
                      setOverflowOpen(false);
                    }}
                  />
                  <SheetItem
                    Icon={MessageSquare}
                    label="Chat"
                    onClick={() => {
                      panel('chat')();
                      setOverflowOpen(false);
                    }}
                  />
                  {p.canUseAi && (
                    <SheetItem
                      Icon={Sparkles}
                      label="AI notes"
                      onClick={() => {
                        panel('ai')();
                        setOverflowOpen(false);
                      }}
                    />
                  )}
                </span>
              </div>
            </Popover>
          )}
        </div>

        <div className="relative hidden md:block">
          <Control label="Change layout" active={layoutOpen} onClick={() => setLayoutOpen((o) => !o)}>
            <LayoutGrid size={19} />
          </Control>
          {layoutOpen && (
            <Popover onClose={() => setLayoutOpen(false)}>
              <div className="flex gap-1">
                {LAYOUTS.map(({ key, label, Icon }) => (
                  <button
                    key={key}
                    onClick={() => {
                      p.onSetLayout(key);
                      setLayoutOpen(false);
                    }}
                    className={
                      'flex w-20 flex-col items-center gap-1 rounded-full px-2 py-2 text-[11px] font-medium transition-colors duration-150 ' +
                      (p.layout === key ? 'bg-blue-600 text-white' : 'text-white/70 hover:bg-white/10')
                    }
                  >
                    <Icon size={17} />
                    {label}
                  </button>
                ))}
              </div>
            </Popover>
          )}
        </div>

        <Control label="Leave the meeting" danger onClick={p.onLeave}>
          <PhoneOff size={19} />
        </Control>
      </div>

      {/* Right — the host's end-for-all, kept away from their own leave button. */}
      <div className="hidden min-w-0 flex-1 items-center justify-end gap-2 sm:flex">
        {p.isHost && p.onEndForAll && (
          <button
            onClick={p.onEndForAll}
            className="rounded-full border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors duration-150 hover:bg-red-600 hover:text-white"
          >
            End for everyone
          </button>
        )}
        <span className="flex items-center gap-1 text-xs text-white/50">
          <Users size={13} /> {p.participantCount}
        </span>
      </div>
    </div>
  );
};

const SheetItem: React.FC<{
  Icon: typeof Mic;
  label: string;
  hint?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}> = ({ Icon, label, hint, active, disabled, onClick }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={
      'flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors duration-150 ' +
      (disabled
        ? 'cursor-not-allowed text-white/30'
        : active
          ? 'bg-blue-600/20 text-blue-200 hover:bg-blue-600/30'
          : 'text-white/80 hover:bg-white/10')
    }
  >
    <Icon size={16} className="mt-0.5 shrink-0" />
    <span className="min-w-0">
      <span className="block truncate font-medium">{label}</span>
      {hint && <span className="block text-[11px] text-white/40">{hint}</span>}
    </span>
    {active && <ChevronUp size={13} className="ml-auto mt-1 shrink-0 opacity-50" />}
  </button>
);
