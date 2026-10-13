import React, { useState } from 'react';
import { CalendarClock } from 'lucide-react';

/**
 * Pick when a post goes out (D-05): the common times one tap away, any
 * other time in a visible date-and-time field. It replaces a hidden native
 * input that many browsers never opened from its icon.
 */
const at = (days: number, hour: number, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d;
};
const nextMonday = () => {
  const d = at(1, 8);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return d;
};
export const toLocalInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const SchedulePicker: React.FC<{
  value: string;
  onChange: (local: string) => void;
  onClose?: () => void;
}> = ({ value, onChange, onClose }) => {
  const [custom, setCustom] = useState(value || toLocalInput(at(1, 7, 30)));
  const presets = [
    { label: 'In an hour', date: new Date(Date.now() + 3600_000) },
    { label: 'Tomorrow 7:30', date: at(1, 7, 30) },
    { label: 'Tomorrow 12:00', date: at(1, 12) },
    { label: 'Monday 8:00', date: nextMonday() },
  ];
  const valid = custom && Date.parse(custom) > Date.now();
  return (
    <div className="mt-3 rounded-xl border border-border-light p-3 dark:border-border-dark/50" role="group" aria-label="Schedule">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-primary-light dark:text-text-primary-dark">
        <CalendarClock size={13} /> Schedule for later
      </p>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button key={p.label} type="button" onClick={() => { onChange(toLocalInput(p.date)); onClose?.(); }}
            className="rounded-full border border-border-light px-2.5 py-1 text-xs font-medium hover:border-blue-400 hover:text-blue-600 dark:border-border-dark/60">
            {p.label}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input type="datetime-local" value={custom} min={toLocalInput(new Date())} onChange={(e) => setCustom(e.target.value)}
          aria-label="Date and time"
          className="rounded-lg border border-border-light bg-surface-light px-2 py-1 text-sm dark:border-border-dark/60 dark:bg-card-dark/50" />
        <button type="button" disabled={!valid} onClick={() => { onChange(custom); onClose?.(); }}
          className="rounded-full bg-blue-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">Set time</button>
        {!valid && custom && <span className="text-[11px] text-red-600 dark:text-red-400">Pick a time in the future</span>}
      </div>
    </div>
  );
};
