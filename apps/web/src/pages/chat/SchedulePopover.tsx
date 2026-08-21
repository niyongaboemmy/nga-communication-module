import React, { useEffect, useRef, useState } from 'react';
import { Clock, X } from 'lucide-react';
import { Button, IconButton, Spinner } from '../../components/ui';
import { useNotify } from '../../context/NotificationContext';
import * as chatApi from './api';

/**
 * Choose when to send (FR-MSG-18).
 *
 * Presets first, a custom time behind them. Almost every scheduled message in a
 * school is "first thing tomorrow" or "Monday morning" — making everyone drive
 * a datetime picker for that is the difference between a feature people use and
 * one they discover, try once and abandon.
 */

/** Next occurrence of a given local hour, tomorrow if today has passed it. */
function nextAt(hour: number, minute = 0, dayOffset = 0): Date {
  const at = new Date();
  at.setSeconds(0, 0);
  at.setHours(hour, minute);
  if (dayOffset) at.setDate(at.getDate() + dayOffset);
  else if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
  return at;
}

/** The coming Monday at 08:00. */
function nextMonday(): Date {
  const at = nextAt(8, 0);
  while (at.getDay() !== 1) at.setDate(at.getDate() + 1);
  return at;
}

/** `toISOString` is UTC; a datetime-local input wants local wall-clock. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const SchedulePopover: React.FC<{
  conversationId: string;
  body: string;
  onDone: () => void;
  onClose: () => void;
}> = ({ conversationId, body, onDone, onClose }) => {
  const { notify } = useNotify();
  const [custom, setCustom] = useState(() => toLocalInput(nextAt(8, 0)));
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    // Deferred a tick: the click that opened this is still propagating.
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const schedule = async (at: Date) => {
    if (busy) return;
    setBusy(true);
    try {
      await chatApi.scheduleMessage(conversationId, body, at.toISOString());
      notify({
        title: `Scheduled for ${at.toLocaleString(undefined, {
          weekday: 'short', hour: '2-digit', minute: '2-digit',
        })}`,
        tone: 'success',
        confirmation: true,
      });
      onDone();
    } catch (err) {
      notify({
        title: 'That could not be scheduled',
        body: err instanceof Error ? err.message : undefined,
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  const presets: Array<{ label: string; at: Date }> = [
    { label: 'In an hour', at: new Date(Date.now() + 3_600_000) },
    { label: 'Later today, 17:00', at: nextAt(17, 0) },
    { label: 'Tomorrow, 08:00', at: nextAt(8, 0, 1) },
    { label: 'Monday, 08:00', at: nextMonday() },
  ].filter((p) => p.at.getTime() > Date.now() + 60_000);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Schedule this message"
      className="absolute bottom-full right-0 z-50 mb-2 w-64 overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl dark:border-border-dark/50 dark:bg-elevated-dark"
    >
      <header className="flex items-center justify-between border-b border-border-light px-3 py-2 dark:border-border-dark/40">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text-primary-light dark:text-text-primary-dark">
          <Clock size={12} /> Send later
        </h3>
        <IconButton label="Close" size="sm" onClick={onClose}><X size={13} /></IconButton>
      </header>

      <div className="p-2">
        <ul className="space-y-0.5">
          {presets.map((p) => (
            <li key={p.label}>
              <button
                onClick={() => void schedule(p.at)}
                disabled={busy}
                className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs text-text-primary-light hover:bg-surface-light disabled:opacity-50 dark:text-text-primary-dark dark:hover:bg-surface-dark"
              >
                <span>{p.label}</span>
                <span className="text-[10px] tabular-nums text-text-secondary-light dark:text-text-secondary-dark">
                  {p.at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-2 border-t border-border-light pt-2 dark:border-border-dark/40">
          <label className="block text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
            Or pick a time
            <input
              type="datetime-local"
              value={custom}
              min={toLocalInput(new Date(Date.now() + 60_000))}
              onChange={(e) => setCustom(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border-light bg-surface-light px-2 py-1.5 text-xs text-text-primary-light dark:border-border-dark/50 dark:bg-card-dark/60 dark:text-text-primary-dark"
            />
          </label>
          <Button
            className="mt-2 w-full"
            onClick={() => void schedule(new Date(custom))}
            disabled={busy || !custom}
          >
            {busy ? <Spinner className="h-4 w-4" /> : 'Schedule'}
          </Button>
        </div>
      </div>
    </div>
  );
};
