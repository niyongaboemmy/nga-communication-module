import React, { useEffect, useState } from 'react';
import { X, Bell, Volume2, Moon, Eye, CornerDownLeft, Check } from 'lucide-react';
import { IconButton, Spinner } from '../../components/ui';
import { useNotify } from '../../context/NotificationContext';
import { apiGet, apiPatch } from '../../lib/api';
import type { NotificationLevel } from '@tupo/shared';

/**
 * Notification and chat preferences (FR-USR-8, FR-NOTIF).
 *
 * Saved on change rather than behind a Save button. These are single-value
 * toggles with no interdependencies and no validation that could fail; a Save
 * button on such a form exists only to be forgotten, and "I turned it off but
 * it kept buzzing" is exactly the complaint it produces.
 */

interface Prefs {
  readReceipts: boolean;
  enterToSend: boolean;
  desktopNotifications: boolean;
  sound: boolean;
  defaultLevel: NotificationLevel;
  quietFromMinute: number | null;
  quietToMinute: number | null;
  timezone: string | null;
  showPresence: boolean;
}

const toTime = (minutes: number | null) =>
  minutes === null
    ? ''
    : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const fromTime = (value: string): number | null => {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

const Toggle: React.FC<{
  label: string;
  hint?: string;
  icon: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, hint, icon, checked, onChange }) => (
  <label className="flex cursor-pointer items-start gap-3 rounded-xl px-2 py-2 transition-colors duration-150 hover:bg-surface-light dark:hover:bg-surface-dark">
    <span className="mt-0.5 shrink-0 text-text-secondary-light dark:text-text-secondary-dark">
      {icon}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
        {label}
      </span>
      {hint && (
        <span className="mt-0.5 block text-[11px] leading-relaxed text-text-secondary-light dark:text-text-secondary-dark">
          {hint}
        </span>
      )}
    </span>
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-1 h-4 w-4 shrink-0 accent-blue-600"
    />
  </label>
);

export const NotificationSettings: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { notify, requestSystemPermission, systemPermission } = useNotify();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet<{ prefs: Prefs }>('/api/chat/prefs')
      .then((r) => setPrefs(r.data!.prefs))
      .catch(() => notify({ title: 'Could not load your settings', tone: 'error' }));
  }, [notify]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const update = async (patch: Partial<Prefs>) => {
    if (!prefs) return;
    // Applied locally first: a toggle that waits for a round trip before moving
    // feels broken, and people press it twice.
    const previous = prefs;
    setPrefs({ ...prefs, ...patch });
    setSaving(true);
    try {
      const r = await apiPatch<{ prefs: Prefs }>('/api/chat/prefs', {
        ...patch,
        // Sent so the server records which zone the minutes were chosen in.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setPrefs(r.data!.prefs);
    } catch {
      setPrefs(previous);
      notify({ title: 'That setting could not be saved', tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside
      aria-label="Notification settings"
      className="flex h-full min-h-0 w-full flex-col border-l border-border-light bg-white dark:border-border-dark/30 dark:bg-chrome-dark"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 dark:border-border-dark/30">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
          <Bell size={15} /> Notifications
          {saving && <Spinner className="h-3 w-3" />}
        </h2>
        <IconButton label="Close notification settings" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>

      {!prefs ? (
        <div className="grid flex-1 place-items-center"><Spinner /></div>
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
          <section>
            <h3 className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
              Notify me about
            </h3>
            <div className="flex gap-1 rounded-xl border border-border-light p-1 dark:border-border-dark/50">
              {([
                { id: 'all', label: 'Everything' },
                { id: 'mentions', label: 'Mentions' },
                { id: 'none', label: 'Nothing' },
              ] as const).map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => void update({ defaultLevel: id })}
                  aria-pressed={prefs.defaultLevel === id}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors duration-150 ${
                    prefs.defaultLevel === id
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                      : 'text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1 px-2 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
              The default for new conversations. Each one can override it from its details panel.
            </p>
          </section>

          <section>
            <h3 className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
              How
            </h3>
            <Toggle
              icon={<Bell size={15} />}
              label="Desktop notifications"
              hint={systemPermission === 'denied'
                ? 'Blocked by the browser. Allow notifications for this site to switch this back on.'
                : 'Shown when Tupo is in the background.'}
              checked={prefs.desktopNotifications && systemPermission !== 'denied'}
              onChange={async (v) => {
                if (v && systemPermission !== 'granted') {
                  // Must be asked from a gesture, which this click is.
                  const granted = await requestSystemPermission();
                  if (!granted) {
                    notify({ title: 'The browser did not allow notifications', tone: 'warning' });
                    return;
                  }
                }
                void update({ desktopNotifications: v });
              }}
            />
            <Toggle
              icon={<Volume2 size={15} />}
              label="Sound"
              hint="A short cue on a new message, and a different one for a mention."
              checked={prefs.sound}
              onChange={(v) => void update({ sound: v })}
            />
          </section>

          <section>
            <h3 className="mb-1 flex items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
              <Moon size={11} /> Quiet hours
            </h3>
            <div className="flex items-center gap-2 px-2">
              <label className="flex-1">
                <span className="mb-1 block text-[11px] text-text-secondary-light dark:text-text-secondary-dark">From</span>
                <input
                  type="time"
                  value={toTime(prefs.quietFromMinute)}
                  onChange={(e) => void update({ quietFromMinute: fromTime(e.target.value) })}
                  className="w-full rounded-lg border border-border-light bg-surface-light px-2 py-1.5 text-xs text-text-primary-light dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark"
                />
              </label>
              <label className="flex-1">
                <span className="mb-1 block text-[11px] text-text-secondary-light dark:text-text-secondary-dark">Until</span>
                <input
                  type="time"
                  value={toTime(prefs.quietToMinute)}
                  onChange={(e) => void update({ quietToMinute: fromTime(e.target.value) })}
                  className="w-full rounded-lg border border-border-light bg-surface-light px-2 py-1.5 text-xs text-text-primary-light dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark"
                />
              </label>
            </div>
            <p className="mt-1 px-2 text-[11px] leading-relaxed text-text-secondary-light dark:text-text-secondary-dark">
              No sound and no desktop notification during these hours. Messages still arrive and
              still count — you simply are not interrupted.
              {prefs.quietFromMinute !== null && prefs.quietToMinute !== null
                && prefs.quietFromMinute > prefs.quietToMinute
                && ' This range crosses midnight.'}
            </p>
            {(prefs.quietFromMinute !== null || prefs.quietToMinute !== null) && (
              <button
                onClick={() => void update({ quietFromMinute: null, quietToMinute: null })}
                className="mt-1 px-2 text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                Turn quiet hours off
              </button>
            )}
          </section>

          <section>
            <h3 className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
              Privacy and typing
            </h3>
            <Toggle
              icon={<Check size={15} />}
              label="Read receipts"
              hint="Reciprocal: switching this off also stops you seeing whether others have read yours."
              checked={prefs.readReceipts}
              onChange={(v) => void update({ readReceipts: v })}
            />
            <Toggle
              icon={<Eye size={15} />}
              label="Show when I am online"
              checked={prefs.showPresence}
              onChange={(v) => void update({ showPresence: v })}
            />
            <Toggle
              icon={<CornerDownLeft size={15} />}
              label="Enter sends the message"
              hint="When off, Enter starts a new line and the send button posts."
              checked={prefs.enterToSend}
              onChange={(v) => void update({ enterToSend: v })}
            />
          </section>
        </div>
      )}
    </aside>
  );
};
