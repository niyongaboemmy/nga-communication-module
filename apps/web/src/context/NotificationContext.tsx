import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Bell, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { playSound, primeSounds, soundsEnabled, setSoundsEnabled } from '../lib/sounds';
import type { SoundName } from '../lib/sounds';
import { speak, cancelSpeech, speechSupported, voiceEnabled, setVoiceEnabled } from '../lib/speech';

/**
 * In-app notifications: a toast, a sound, and — when the tab is in the
 * background — a system notification.
 *
 * Three delivery channels for one event, because the right one depends on where
 * the person is looking:
 *
 * - **Toast** when they are on the page. Enough to read at a glance, gone on
 * its own, never blocking.
 * - **Sound** always (unless muted), because in a meeting the eyes are on the
 * faces and the ears are free. See lib/sounds.ts for the vocabulary.
 * - **System notification** only when `document.hidden`. Firing one while the
 * tab is visible duplicates the toast and trains people to turn them off.
 */

export type NotificationTone = 'info' | 'success' | 'warning' | 'error';

export interface NotifyOptions {
  title: string;
  body?: string;
  tone?: NotificationTone;
  sound?: SoundName | null;
  /** How long the toast stays. 0 keeps it until dismissed. */
  durationMs?: number;
  /** Clicking the toast runs this. */
  action?: { label: string; onClick: () => void };
  /** Collapses repeats — a second notification with the same key replaces the
   * first rather than stacking. */
  key?: string;
  /** Raise a system notification when the tab is in the background. */
  system?: boolean;
  /** Said aloud when spoken notifications are on. Keep it to one short
   * sentence — a voice reading a paragraph is worse than no voice. */
  speak?: string;
  /** Shown instead of the tone icon: an emoji, or a person's initials. */
  badge?: string;
  /** A confirmation of something the reader just did. Rendered quieter and
   * dismissed faster — you already know it happened. */
  confirmation?: boolean;
}

interface Toast extends NotifyOptions {
  id: string;
  tone: NotificationTone;
  createdAt: number;
  leaving?: boolean;
}

interface NotificationValue {
  notify: (options: NotifyOptions) => void;
  /** Short, quiet acknowledgement of something the reader just did. */
  confirm: (title: string, options?: Partial<NotifyOptions>) => void;
  dismiss: (id: string) => void;
  soundOn: boolean;
  setSoundOn: (on: boolean) => void;
  voiceOn: boolean;
  setVoiceOn: (on: boolean) => void;
  voiceSupported: boolean;
  /** Ask for system-notification permission. Must be called from a gesture. */
  requestSystemPermission: () => Promise<boolean>;
  systemPermission: NotificationPermission | 'unsupported';
}

const NotificationContext = createContext<NotificationValue | null>(null);

const DEFAULT_DURATION = 5000;
const CONFIRM_DURATION = 2200;
const MAX_VISIBLE = 4;

const TONE_STYLE: Record<NotificationTone, { Icon: typeof Info; accent: string; ring: string }> = {
  info: { Icon: Info, accent: 'text-blue-400', ring: 'border-blue-500/25' },
  success: { Icon: CheckCircle2, accent: 'text-emerald-400', ring: 'border-emerald-500/25' },
  warning: { Icon: AlertTriangle, accent: 'text-amber-400', ring: 'border-amber-500/25' },
  error: { Icon: XCircle, accent: 'text-red-400', ring: 'border-red-500/25' },
};

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [soundOn, setSoundOnState] = useState(soundsEnabled);
  const [voiceOn, setVoiceOnState] = useState(voiceEnabled);
  const [systemPermission, setSystemPermission] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>()).current;
  const counter = useRef(0);

  const dismiss = useCallback(
    (id: string) => {
      // Mark it leaving first so the exit animation can run, then remove it.
      setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      const exit = setTimeout(() => {
        setToasts((list) => list.filter((t) => t.id !== id));
        timers.delete(`${id}:exit`);
      }, 180);
      timers.set(`${id}:exit`, exit);
    },
    [timers],
  );

  const notify = useCallback(
    (options: NotifyOptions) => {
      const tone = options.tone ?? 'info';
      const id = options.key ?? `n${++counter.current}`;

      if (options.sound !== null) {
        playSound(options.sound ?? defaultSoundFor(tone));
      }
      // Spoken last, so the chime leads it — the tone gets attention, the words
      // supply the detail.
      if (options.speak) speak(options.speak, { interrupt: tone === 'error' });

      setToasts((list) => {
        // A keyed notification replaces its predecessor rather than stacking:
        // "3 people are waiting" should not be three separate toasts.
        const withoutSame = list.filter((t) => t.id !== id);
        const next: Toast = { ...options, id, tone, createdAt: Date.now() };
        // Oldest fall off the top once there are too many to read.
        return [...withoutSame, next].slice(-MAX_VISIBLE);
      });

      const duration = options.durationMs ?? (options.confirmation ? CONFIRM_DURATION : DEFAULT_DURATION);
      const existing = timers.get(id);
      if (existing) clearTimeout(existing);
      if (duration > 0) {
        timers.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }

      // Only when they are not looking. A system notification for something
      // already on screen is noise, and noise is why people disable them.
      if (
        options.system &&
        document.hidden &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        try {
          const system = new Notification(options.title, {
            body: options.body,
            tag: id,
            icon: '/favicon.svg',
          });
          system.onclick = () => {
            window.focus();
            options.action?.onClick();
            system.close();
          };
        } catch {
          /* the browser refused; the toast still stands */
        }
      }
    },
    [dismiss, timers],
  );

  /**
   * Acknowledge something the reader just did.
   *
   * Separate from `notify` because the two are different in kind: a
   * notification tells you something you did not know, a confirmation tells you
   * that what you just asked for happened. Confirmations are quieter, shorter,
   * never spoken and never raised to the system — you were looking at the
   * screen when you pressed the button.
   */
  const confirmAction = useCallback(
    (title: string, options: Partial<NotifyOptions> = {}) => {
      notify({
        tone: 'success',
        sound: 'success',
        confirmation: true,
        ...options,
        title,
        speak: undefined,
        system: false,
      });
    },
    [notify],
  );

  const setSoundOn = useCallback((on: boolean) => {
    setSoundsEnabled(on);
    setSoundOnState(on);
    // Confirm audibly when switching on — otherwise there is no way to know it
    // worked until the next event, which may be minutes away.
    if (on) {
      primeSounds();
      playSound('success');
    }
  }, []);

  const setVoiceOn = useCallback((on: boolean) => {
    setVoiceEnabled(on);
    setVoiceOnState(on);
    if (on) speak('Spoken notifications are on.', { force: true });
    else cancelSpeech();
  }, []);

  const requestSystemPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') return true;
    try {
      const result = await Notification.requestPermission();
      setSystemPermission(result);
      return result === 'granted';
    } catch {
      return false;
    }
  }, []);

  useEffect(
    () => () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    [timers],
  );

  const value = useMemo<NotificationValue>(
    () => ({
      notify,
      confirm: confirmAction,
      dismiss,
      soundOn,
      setSoundOn,
      voiceOn,
      setVoiceOn,
      voiceSupported: speechSupported(),
      requestSystemPermission,
      systemPermission,
    }),
    [
      notify,
      confirmAction,
      dismiss,
      soundOn,
      setSoundOn,
      voiceOn,
      setVoiceOn,
      requestSystemPermission,
      systemPermission,
    ],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </NotificationContext.Provider>
  );
};

export function useNotify(): NotificationValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotify must be used inside a NotificationProvider');
  return ctx;
}

const defaultSoundFor = (tone: NotificationTone): SoundName =>
  tone === 'error' ? 'error' : tone === 'success' ? 'success' : 'message';

/* ------------------------------------------------------------------ *
 * The stack
 * ------------------------------------------------------------------ */

const ToastStack: React.FC<{ toasts: Toast[]; onDismiss: (id: string) => void }> = ({
  toasts,
  onDismiss,
}) => {
  if (toasts.length === 0) return null;

  return createPortal(
    <div
      // Polite rather than assertive: these narrate what is happening, they do
      // not interrupt what someone is doing.
      role="status"
      aria-live="polite"
      // Top-right, below the app bar, and above the mini-call so a notification
      // is never hidden behind the thing it is about.
      //
      // `--tupo-toast-right` lets whatever is on screen push the stack aside —
      // the meeting sets it while a side panel is open, so a notification never
      // lands on top of the panel it is telling you to open. A variable rather
      // than a prop because this renders in a portal, far from that state.
      style={{ right: 'var(--tupo-toast-right, 0.75rem)' }}
      className="pointer-events-none fixed top-20 z-100 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 transition-[right] duration-200"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body,
  );
};

const ToastCard: React.FC<{ toast: Toast; onDismiss: (id: string) => void }> = ({ toast, onDismiss }) => {
  const { Icon, accent, ring } = TONE_STYLE[toast.tone];
  const duration = toast.durationMs ?? (toast.confirmation ? CONFIRM_DURATION : DEFAULT_DURATION);
  const [paused, setPaused] = useState(false);

  return (
    <div
      // Hovering holds it. Reading a notification that vanishes mid-sentence is
      // the most common complaint about toasts, and it costs nothing to fix.
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={
        'pointer-events-auto relative overflow-hidden rounded-xl border ' +
        ' backdrop-blur-md transition-transform duration-150 hover:-translate-x-0.5 ' +
        // A confirmation is quieter than a notification: you already know it
        // happened, so it should register without competing for attention.
        (toast.confirmation ? 'border-white/10 bg-slate-900/90 ' : `bg-slate-900/95 ${ring} `) +
        (toast.leaving ? 'animate-toast-out' : 'animate-toast-in')
      }
    >
      <div className={`flex items-start gap-2.5 ${toast.confirmation ? 'p-2.5' : 'p-3'}`}>
        {toast.badge ? (
          <span
            aria-hidden="true"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/10 text-sm"
          >
            {toast.badge}
          </span>
        ) : (
          <Icon size={toast.confirmation ? 14 : 16} className={`mt-0.5 shrink-0 ${accent}`} />
        )}

        <div className="min-w-0 flex-1">
          <p
            className={
              'leading-snug text-white ' +
              (toast.confirmation ? 'text-xs font-medium' : 'text-sm font-medium')
            }
          >
            {toast.title}
          </p>
          {toast.body && (
            <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-white/60">{toast.body}</p>
          )}
          {toast.action && (
            <button
              onClick={() => {
                toast.action?.onClick();
                onDismiss(toast.id);
              }}
              className="mt-1.5 rounded-md bg-white/10 px-2 py-1 text-xs font-medium text-blue-200 transition-colors duration-150 hover:bg-white/20 hover:text-white"
            >
              {toast.action.label}
            </button>
          )}
        </div>

        <button
          onClick={() => onDismiss(toast.id)}
          aria-label="Dismiss"
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-white/30 transition-colors duration-150 hover:bg-white/10 hover:text-white"
        >
          <X size={12} />
        </button>
      </div>

      {/* How long is left. Only for toasts that actually expire — a bar that
 never moves on a sticky notification reads as broken. */}
      {duration > 0 && !toast.leaving && (
        <span
          aria-hidden="true"
          className={`absolute inset-x-0 bottom-0 h-0.5 origin-left ${
            toast.tone === 'error'
              ? 'bg-red-500/60'
              : toast.tone === 'warning'
                ? 'bg-amber-400/60'
                : toast.tone === 'success'
                  ? 'bg-emerald-400/60'
                  : 'bg-blue-400/60'
          }`}
          style={{
            animation: `tupo-toast-progress ${duration}ms linear forwards`,
            animationPlayState: paused ? 'paused' : 'running',
          }}
        />
      )}
    </div>
  );
};

/** The bell used in the app bar to reach sound and notification settings. */
export const NotificationSettingsIcon = Bell;
