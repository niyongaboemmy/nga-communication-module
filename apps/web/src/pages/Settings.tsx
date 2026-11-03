import React, { useState } from 'react';
import { ExternalLink, LogOut, Monitor, Moon, Sun } from 'lucide-react';
import type { PresenceChoice } from '@tupo/shared';
import { useAuth } from '../context/AuthContext';
import { useNotify } from '../context/NotificationContext';
import { usePermissions } from '../hooks/usePermissions';
import { Avatar, Card, PageHeader, PresenceDot, type Presence } from '../components/ui';
import { STATUS_CHOICES, chooseStatus, useMyStatus } from '../lib/myStatus';
import { toPresence } from './chat/types';
import { NotificationSettings } from './chat/NotificationSettings';
import type { ThemeMode } from '../lib/theme';

/**
 * Profile and settings (F-10): one place for who you are, how you appear to
 * others, how Tupo looks, and what it interrupts you about. Before this the
 * theme was a bare icon, status could not be set at all, and notification
 * settings were reachable only from inside chat.
 */

/** The dot a pick shows others; "automatic" is shown as online. */
export const CHOICE_DOT: Record<PresenceChoice, Presence> = {
  auto: 'online', busy: 'busy', dnd: 'busy', invisible: 'offline',
};

export const STATUS_LABEL: Record<string, string> = {
  online: 'Online', away: 'Away', busy: 'Busy', 'in-a-meeting': 'In a meeting',
  dnd: 'Do not disturb', offline: 'Offline',
};

const THEMES: ReadonlyArray<{ id: ThemeMode; label: string; Icon: typeof Sun }> = [
  { id: 'system', label: 'System', Icon: Monitor },
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'dark', label: 'Dark', Icon: Moon },
];

const SectionTitle: React.FC<{ children: React.ReactNode; hint?: string }> = ({ children, hint }) => (
  <div className="mb-3">
    <h2 className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">{children}</h2>
    {hint && <p className="mt-0.5 text-xs text-text-secondary-light dark:text-text-secondary-dark">{hint}</p>}
  </div>
);

/** The status picker, shared by this page and the account menu. */
export const StatusPicker: React.FC<{ compact?: boolean; onPicked?: () => void }> = ({ compact = false, onPicked }) => {
  const { choice } = useMyStatus();
  const { notify } = useNotify();
  const [busy, setBusy] = useState(false);

  const pick = async (next: PresenceChoice) => {
    if (next === choice || busy) return;
    setBusy(true);
    const ok = await chooseStatus(next);
    setBusy(false);
    if (!ok) notify({ title: 'Your status could not be changed', body: 'Check your connection and try again.', tone: 'error' });
    else onPicked?.();
  };

  return (
    <div role="radiogroup" aria-label="Your status" className={compact ? 'space-y-0.5' : 'grid gap-2 sm:grid-cols-2'}>
      {STATUS_CHOICES.map((c) => {
        const selected = c.id === choice;
        return (
          <button
            key={c.id}
            role="radio"
            aria-checked={selected}
            onClick={() => void pick(c.id)}
            className={
              'flex w-full items-center gap-2.5 text-left transition-colors duration-150 ' +
              (compact
                ? 'rounded-xl px-2.5 py-1.5 text-sm hover:bg-surface-light dark:hover:bg-surface-dark '
                : 'rounded-xl border px-3 py-2.5 ' +
                  (selected
                    ? 'border-blue-500 bg-blue-50/60 dark:border-blue-400 dark:bg-blue-500/10 '
                    : 'border-border-light hover:bg-surface-light dark:border-border-dark/50 dark:hover:bg-surface-dark '))
            }
          >
            <PresenceDot presence={CHOICE_DOT[c.id]} className="h-2.5 w-2.5 shrink-0 !ring-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-text-primary-light dark:text-text-primary-dark">{c.label}</span>
              {!compact && <span className="block text-xs text-text-secondary-light dark:text-text-secondary-dark">{c.hint}</span>}
            </span>
            {selected && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-blue-600 dark:bg-blue-400" />}
          </button>
        );
      })}
    </div>
  );
};

export const Settings: React.FC = () => {
  const { user, themeMode, setThemeMode, signOut } = useAuth();
  const { roleName } = usePermissions();
  const mine = useMyStatus();
  if (!user) return null;

  const misHomeUrl =
    import.meta.env.VITE_MIS_HOME_URL ||
    (import.meta.env.VITE_MIS_LOGIN_URL || '').replace(/\/login\/?$/, '');

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 pt-5 sm:px-6 sm:pt-6">
      <PageHeader title="Settings" subtitle="Your profile, your status, how Tupo looks and what it tells you about." />

      <div className="space-y-5">
        <Card className="p-4 sm:p-5">
          <SectionTitle>Profile</SectionTitle>
          <div className="flex flex-wrap items-center gap-4">
            <Avatar name={user.name} src={user.avatarUrl} size={64} preview previewCaption={roleName ?? undefined}
              presence={toPresence(mine.status)} />
            {/* On a phone the name gets its own line rather than being squeezed. */}
            <div className="min-w-0 flex-1 max-sm:basis-full">
              <p className="truncate text-base font-semibold text-text-primary-light dark:text-text-primary-dark">{user.name}</p>
              {user.email && <p className="truncate text-sm text-text-secondary-light dark:text-text-secondary-dark">{user.email}</p>}
              <p className="mt-1 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                {roleName ? `${roleName} · ` : ''}Others see you as <span className="font-medium">{STATUS_LABEL[mine.status] ?? 'Online'}</span>
              </p>
            </div>
            {misHomeUrl && (
              <a href={misHomeUrl} target="_blank" rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border-light px-3 py-1.5 text-xs font-medium text-text-primary-light hover:bg-surface-light dark:border-border-dark/50 dark:text-text-primary-dark dark:hover:bg-surface-dark">
                Edit in NGA MIS <ExternalLink size={12} />
              </a>
            )}
          </div>
          <p className="mt-3 text-xs text-text-secondary-light dark:text-text-secondary-dark">
            Your name, photo and role come from your NGA MIS account.
          </p>
        </Card>

        <Card className="p-4 sm:p-5">
          <SectionTitle hint="Applies on every device you use Tupo on. A meeting shows you as “In a meeting” on its own.">
            Status
          </SectionTitle>
          <StatusPicker />
        </Card>

        <Card className="p-4 sm:p-5">
          <SectionTitle hint="“System” follows your device, including when it switches at night.">Appearance</SectionTitle>
          <div role="radiogroup" aria-label="Theme" className="inline-flex gap-1 rounded-xl border border-border-light p-1 dark:border-border-dark/50">
            {THEMES.map(({ id, label, Icon }) => (
              <button
                key={id}
                role="radio"
                aria-checked={themeMode === id}
                onClick={() => setThemeMode(id)}
                className={
                  'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors duration-150 ' +
                  (themeMode === id
                    ? 'bg-blue-600 text-white'
                    : 'text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark')
                }
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <NotificationSettings embedded />
        </Card>

        <Card className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
          <div>
            <h2 className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">Sign out</h2>
            <p className="mt-0.5 text-xs text-text-secondary-light dark:text-text-secondary-dark">Signs this device out of Tupo and stops its notifications.</p>
          </div>
          <button onClick={signOut}
            className="inline-flex items-center gap-1.5 rounded-full border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-900/20">
            <LogOut size={15} /> Sign out
          </button>
        </Card>
      </div>
    </div>
  );
};
