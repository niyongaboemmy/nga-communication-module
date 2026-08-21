import React, { useMemo, useState } from 'react';
import { CalendarPlus, Check, ChevronDown, Loader2 } from 'lucide-react';
import { MEET_CATEGORIES, type MeetCategory } from '@tupo/shared';

/**
 * Quick-create, attached to the calendar.
 *
 * The research is consistent on this: the fast path should be pick-a-slot,
 * name it, done — and the full editor should be available but never in the
 * way. So this asks for four things at most, defaults three of them, and
 * hands off to the full scheduler for anything richer.
 *
 * Times are offered as chips because typing "14:30" into a masked input is
 * slower than pointing at it, and because the chips can be *smart*: the first
 * one offered is the next half hour, not 09:00 on a day that is already half
 * gone.
 */

const DURATIONS = [15, 30, 45, 60, 90] as const;

const CATEGORY_LABEL: Record<MeetCategory, string> = {
  private: 'Invited only',
  loggedIn: 'Anyone signed in',
  public: 'Anyone with the link',
};

/**
 * The time to propose.
 *
 * The next half hour, so the default is never in the past — but clamped to
 * hours a school actually meets in. Someone opening this at half past midnight
 * is scheduling for the morning, and offering them 01:00 is a suggestion no
 * one will ever take.
 */
const DAY_OPENS = 8;
const DAY_CLOSES = 17;

function nextSlot(day: Date): Date {
  const now = new Date();
  const base = new Date(day);

  if (day.toDateString() !== now.toDateString()) {
    base.setHours(DAY_OPENS + 1, 0, 0, 0);      // 09:00 on any other day
    return base;
  }

  base.setHours(now.getHours(), now.getMinutes() > 30 ? 60 : 30, 0, 0);
  // Rolled past midnight, or the working day has not started yet.
  if (base.getDate() !== now.getDate() || base.getHours() < DAY_OPENS) {
    base.setTime(day.getTime());
    base.setHours(DAY_OPENS + 1, 0, 0, 0);
  }
  return base;
}

/** The 24h value `<input type="time">` requires — never shown to the reader. */
const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** The same instant, written the way the rest of the page writes times. */
function readableTime(value: string): string {
  const [h, m] = value.split(':').map(Number);
  const d = new Date();
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export const QuickSchedule: React.FC<{
  day: Date;
  busy?: boolean;
  onSchedule: (input: {
    title: string; scheduledStart: string; scheduledEnd: string; category: MeetCategory;
  }) => Promise<void>;
  onOpenFull: () => void;
}> = ({ day, busy, onSchedule, onOpenFull }) => {
  const [title, setTitle] = useState('');
  const [time, setTime] = useState(() => hhmm(nextSlot(day)));
  const [minutes, setMinutes] = useState<number>(30);
  const [category, setCategory] = useState<MeetCategory>('loggedIn');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-propose the time when the day changes: 09:00 tomorrow, the next half
  // hour today.
  React.useEffect(() => { setTime(hhmm(nextSlot(day))); }, [day]);

  const suggestions = useMemo(() => {
    const first = nextSlot(day);
    const slots: string[] = [];
    for (let i = 0; slots.length < 4 && i < 12; i++) {
      const t = new Date(first);
      t.setMinutes(t.getMinutes() + i * 60);
      // Past the end of the working day the suggestions stop being useful, so
      // they stop — the time input is still there for anything unusual.
      if (t.getHours() > DAY_CLOSES) break;
      slots.push(hhmm(t));
    }
    return slots.length ? slots : [hhmm(first)];
  }, [day]);

  const start = useMemo(() => {
    const [h, m] = time.split(':').map(Number);
    const d = new Date(day);
    d.setHours(h ?? 9, m ?? 0, 0, 0);
    return d;
  }, [day, time]);

  const inPast = start.getTime() < Date.now();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const end = new Date(start.getTime() + minutes * 60_000);
      await onSchedule({
        title: title.trim() || `Meeting · ${start.toLocaleDateString([], { day: 'numeric', month: 'short' })}`,
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        category,
      });
      setTitle('');
      setDone(true);
      window.setTimeout(() => setDone(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not schedule that.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
          New meeting
        </h3>
        <span className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
          {day.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
        </span>
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What is it about?"
        maxLength={200}
        className="w-full rounded-xl border border-border-light bg-white px-3 py-2 text-sm text-text-primary-light placeholder:text-text-secondary-light/50 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark dark:bg-elevated-dark dark:text-text-primary-dark"
      />

      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((t) => (
          <Chip key={t} active={time === t} onClick={() => setTime(t)}>{readableTime(t)}</Chip>
        ))}
        <label className="relative">
          <span className="sr-only">Start time</span>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="rounded-lg border border-border-light bg-white px-2 py-1 text-xs text-text-primary-light focus:border-blue-500 focus:outline-none dark:border-border-dark dark:bg-elevated-dark dark:text-text-primary-dark"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {DURATIONS.map((m) => (
          <Chip key={m} active={minutes === m} onClick={() => setMinutes(m)}>
            {m < 60 ? `${m}m` : m === 60 ? '1h' : `${m / 60}h`}
          </Chip>
        ))}
      </div>

      <label className="relative block">
        <span className="sr-only">Who may join</span>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as MeetCategory)}
          className="w-full appearance-none rounded-xl border border-border-light bg-white py-2 pl-3 pr-8 text-xs text-text-primary-light focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark dark:bg-elevated-dark dark:text-text-primary-dark"
        >
          {MEET_CATEGORIES.map((c) => (
            <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
          ))}
        </select>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-secondary-light/60 dark:text-text-secondary-dark/60"
        />
      </label>

      {/* Said before the button is pressed, not after it fails. */}
      {inPast && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          That time has already passed — it will be scheduled anyway.
        </p>
      )}
      {error && <p className="text-[11px] text-red-500">{error}</p>}

      <button
        type="submit"
        disabled={saving || busy}
        className="tupo-lift flex w-full items-center justify-center gap-1.5 rounded-full bg-blue-600 hover:bg-blue-500 px-3 py-2 text-sm font-semibold text-white transition-colors duration-150 disabled:opacity-50"
      >
        {saving ? <Loader2 size={14} className="animate-spin" />
          : done ? <Check size={14} />
          : <CalendarPlus size={14} />}
        {done ? 'Added to calendar' : 'Add to calendar'}
      </button>

      <button
        type="button"
        onClick={onOpenFull}
        className="w-full rounded-full px-3 py-1.5 text-xs text-text-secondary-light transition-colors duration-150 hover:bg-surface-light hover:text-text-primary-light dark:text-text-secondary-dark dark:hover:bg-white/5 dark:hover:text-text-primary-dark"
      >
        More options — invite people, recording, AI
      </button>
    </form>
  );
};

const Chip: React.FC<{
  active: boolean; onClick: () => void; children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={
      'rounded-full px-2 py-1 text-xs font-medium transition-colors duration-150 ' +
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ' +
      (active
        ? 'bg-blue-600 text-white'
        : 'bg-surface-light text-text-secondary-light hover:bg-border-light dark:bg-white/5 dark:text-text-secondary-dark dark:hover:bg-white/10')
    }
  >
    {children}
  </button>
);
