import React, { useMemo, useRef, useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';

/**
 * The month grid.
 *
 * A calendar here is not somewhere to browse — it answers a small set of
 * urgent questions: what is on today, am I free at that time, and what did I
 * just agree to. So it is deliberately a *navigator*, compact enough to sit
 * beside the agenda rather than replacing it, and the agenda carries the
 * detail.
 *
 * Density is shown as dots rather than titles. At this size a title truncates
 * to noise, whereas "three things on Thursday" is legible at a glance and is
 * the question people actually bring to a month view.
 *
 * Accessibility is not an afterthought here: it is a real `role="grid"` with
 * roving tabindex, so arrow keys walk the dates, Home/End reach the ends of a
 * week, PageUp/PageDown change month, and a screen reader announces each cell
 * as a date with its count. A calendar that can only be used with a mouse
 * excludes exactly the people who most rely on knowing their own schedule.
 */

export interface CalendarEntry {
  id: string;
  title: string;
  /** ISO instant. */
  start: string;
  status: string;
}

/** Two chips fit a cell at this size; beyond that the count says more. */
const CHIPS_PER_DAY = 2;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Local-midnight key, so grouping never slips a day across a timezone. */
export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const sameDay = (a: Date, b: Date) => dayKey(a) === dayKey(b);
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Monday-first, always six rows — a grid that changes height jumps the page. */
function monthMatrix(month: Date): Date[] {
  const first = startOfMonth(month);
  const offset = (first.getDay() + 6) % 7;          // 0 = Monday
  const start = addDays(first, -offset);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export const MeetCalendar: React.FC<{
  entries: CalendarEntry[];
  selected: Date;
  onSelect: (d: Date) => void;
  /** Opening a meeting straight from its chip, without going via the agenda. */
  onOpenEntry?: (id: string) => void;
}> = ({ entries, selected, onSelect, onOpenEntry }) => {
  const [month, setMonth] = useState(() => startOfMonth(selected));
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState(() => dayKey(selected));

  // Following the selection into another month matters when the agenda is what
  // moved — picking "next Tuesday" from a list should bring the grid with it.
  useEffect(() => {
    setMonth((m) => (
      selected.getFullYear() === m.getFullYear() && selected.getMonth() === m.getMonth()
        ? m : startOfMonth(selected)
    ));
    setFocusKey(dayKey(selected));
  }, [selected]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const e of entries) {
      const key = dayKey(new Date(e.start));
      const list = map.get(key);
      if (list) list.push(e); else map.set(key, [e]);
    }
    return map;
  }, [entries]);

  const days = useMemo(() => monthMatrix(month), [month]);
  const today = new Date();

  const move = (from: Date, delta: number) => {
    const next = addDays(from, delta);
    setFocusKey(dayKey(next));
    if (next.getMonth() !== month.getMonth()) setMonth(startOfMonth(next));
    // Focus follows the roving tabindex once React has painted the new cell.
    requestAnimationFrame(() => {
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${dayKey(next)}"]`)?.focus();
    });
  };

  const onKeyDown = (e: React.KeyboardEvent, day: Date) => {
    const keys: Record<string, number> = {
      ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7,
    };
    if (e.key in keys) { e.preventDefault(); move(day, keys[e.key]!); return; }
    if (e.key === 'Home') { e.preventDefault(); move(day, -((day.getDay() + 6) % 7)); return; }
    if (e.key === 'End') { e.preventDefault(); move(day, 6 - ((day.getDay() + 6) % 7)); return; }
    if (e.key === 'PageUp') { e.preventDefault(); setMonth((m) => addMonths(m, -1)); return; }
    if (e.key === 'PageDown') { e.preventDefault(); setMonth((m) => addMonths(m, 1)); }
  };

  const monthLabel = month.toLocaleDateString([], { month: 'long', year: 'numeric' });

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold tracking-tight text-text-primary-light dark:text-text-primary-dark">
          {monthLabel}
        </h3>
        <div className="flex items-center gap-0.5">
          <NavButton label="Previous month" onClick={() => setMonth((m) => addMonths(m, -1))}>
            <ChevronLeft size={15} />
          </NavButton>
          <button
            onClick={() => { setMonth(startOfMonth(today)); onSelect(today); }}
            className="rounded-full px-2 py-1 text-xs font-medium text-text-secondary-light transition-colors duration-150 hover:bg-surface-light hover:text-text-primary-light dark:text-text-secondary-dark dark:hover:bg-white/5 dark:hover:text-text-primary-dark"
          >
            Today
          </button>
          <NavButton label="Next month" onClick={() => setMonth((m) => addMonths(m, 1))}>
            <ChevronRight size={15} />
          </NavButton>
        </div>
      </div>

      <div role="grid" aria-label={`Meetings in ${monthLabel}`} ref={gridRef}>
        <div role="row" className="grid grid-cols-7">
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              role="columnheader"
              aria-label={d}
              className="pb-2 text-center text-[11px] font-semibold uppercase tracking-wide text-text-secondary-light/60 dark:text-text-secondary-dark/60"
            >
              <span className="hidden sm:inline">{d}</span>
              <span className="sm:hidden">{d.slice(0, 1)}</span>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {days.map((day) => {
            const key = dayKey(day);
            const dayEntries = byDay.get(key) ?? [];
            const outside = day.getMonth() !== month.getMonth();
            const isToday = sameDay(day, today);
            const isSelected = sameDay(day, selected);

            return (
              <div
                key={key}
                role="gridcell"
                data-day={key}
                aria-selected={isSelected}
                aria-current={isToday ? 'date' : undefined}
                // Roving tabindex: exactly one cell is in the tab order and the
                // arrow keys move it. Forty-two tab stops would be worse than
                // useless.
                tabIndex={key === focusKey ? 0 : -1}
                aria-label={
                  `${day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}` +
                  (dayEntries.length
                    ? `, ${dayEntries.length} meeting${dayEntries.length > 1 ? 's' : ''}`
                    : ', no meetings')
                }
                onClick={() => { setFocusKey(key); onSelect(day); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault(); setFocusKey(key); onSelect(day); return;
                  }
                  onKeyDown(e, day);
                }}
                className={
                  'group/cell relative flex min-h-[44px] cursor-pointer flex-col gap-1 rounded-xl border p-1 ' +
                  'sm:min-h-[86px] sm:p-1.5 ' +
                  'transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ' +
                  (isSelected
                    ? 'border-blue-500 bg-blue-50/70 dark:border-blue-500/70 dark:bg-blue-500/10'
                    : outside
                      ? 'border-transparent bg-transparent hover:bg-surface-light dark:hover:bg-white/[0.03]'
                      : 'border-border-light/70 bg-white hover:border-blue-300 dark:border-border-dark/50 dark:bg-white/[0.02] dark:hover:border-blue-800')
                }
              >
                <span className="flex items-center justify-between">
                  <span className={
                    'grid h-6 w-6 place-items-center rounded-full text-xs ' +
                    (isToday
                      ? 'bg-blue-600 font-semibold text-white'
                      : isSelected
                        ? 'font-semibold text-blue-600 dark:text-blue-300'
                        : outside
                          ? 'text-text-secondary-light/35 dark:text-text-secondary-dark/30'
                          : 'font-medium text-text-primary-light dark:text-text-primary-dark')
                  }>
                    {day.getDate()}
                  </span>

                  {/* Only on hover, and only where something can be added —
                      a plus on every one of forty-two cells is noise. */}
                  {!outside && (
                    <span
                      aria-hidden="true"
                      className="hidden text-text-secondary-light/0 transition-colors duration-150 group-hover/cell:text-text-secondary-light/60 sm:block dark:group-hover/cell:text-text-secondary-dark/60"
                    >
                      <Plus size={12} />
                    </span>
                  )}
                </span>

                {/* The meetings themselves, not a dot standing in for them.
                    At this size the title fits, and a title is what tells you
                    whether the day is busy with the thing you care about. */}
                {/* Below `sm` the same information as dots — a title clipped
                    to four characters tells you less than a dot does. */}
                {dayEntries.length > 0 && (
                  <span className="flex items-center justify-center gap-0.5 sm:hidden">
                    {dayEntries.slice(0, 3).map((e) => (
                      <span
                        key={e.id}
                        className={
                          'h-1 w-1 rounded-full ' +
                          (e.status === 'live' ? 'bg-red-500' : 'bg-blue-500')
                        }
                      />
                    ))}
                  </span>
                )}

                <span className="hidden min-h-0 flex-col gap-0.5 sm:flex">
                  {dayEntries.slice(0, CHIPS_PER_DAY).map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      tabIndex={-1}
                      onClick={(ev) => { ev.stopPropagation(); onOpenEntry?.(e.id); }}
                      title={`${new Date(e.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${e.title}`}
                      className={
                        'truncate rounded-md px-1.5 py-0.5 text-left text-[10px] font-medium leading-tight ' +
                        'transition-colors duration-150 ' +
                        (e.status === 'live'
                          ? 'bg-red-500/15 text-red-600 hover:bg-red-500/25 dark:text-red-300'
                          : e.status === 'scheduled'
                            ? 'bg-blue-500/12 text-blue-700 hover:bg-blue-500/22 dark:bg-blue-500/15 dark:text-blue-300'
                            : 'bg-slate-500/10 text-text-secondary-light hover:bg-slate-500/20 dark:text-text-secondary-dark')
                      }
                    >
                      {e.title}
                    </button>
                  ))}
                  {dayEntries.length > CHIPS_PER_DAY && (
                    <span className="px-1.5 text-[10px] font-semibold text-text-secondary-light/70 dark:text-text-secondary-dark/70">
                      +{dayEntries.length - CHIPS_PER_DAY} more
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const NavButton: React.FC<{
  label: string; onClick: () => void; children: React.ReactNode;
}> = ({ label, onClick, children }) => (
  <button
    onClick={onClick}
    aria-label={label}
    className="grid h-7 w-7 place-items-center rounded-full text-text-secondary-light transition-colors duration-150 hover:bg-surface-light hover:text-text-primary-light focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-text-secondary-dark dark:hover:bg-white/5 dark:hover:text-text-primary-dark"
  >
    {children}
  </button>
);
