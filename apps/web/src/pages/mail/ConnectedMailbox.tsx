import React, { useCallback, useEffect, useState } from 'react';
import { AtSign, CheckCircle2, AlertTriangle, Loader2, RefreshCw, Unplug, Eye, EyeOff, PauseCircle, PlayCircle } from 'lucide-react';
import type { MailAccountSettings } from '@tupo/shared';
import { Button, Skeleton } from '../../components/ui';
import { useNotify } from '../../context/NotificationContext';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { useAuth } from '../../context/AuthContext';
import * as api from './api';

const ago = (iso: string | null) => {
  if (!iso) return 'not yet';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};

/**
 * Connect your school mailbox (docs/MAIL_INBOUND_PLAN_2026-11.md §2.1): the
 * email you receive from outside shows in Tupo Mail, and replies can go out
 * as your own address. The password is checked against the school's mail
 * server before anything is kept, and is stored encrypted.
 */
export const ConnectedMailbox: React.FC = () => {
  const { user } = useAuth();
  const { notify, confirm: confirmed } = useNotify();
  const [confirm, dialog] = useConfirmDialog();
  const [settings, setSettings] = useState<MailAccountSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [address, setAddress] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [sendAs, setSendAs] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'connect' | 'sync' | 'disconnect' | 'toggle'>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try { setSettings(await api.getMailAccount()); }
    catch { setLoadFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // While the first sync runs, the counts move: check back a few times.
  useEffect(() => {
    if (!settings?.account || settings.account.lastSyncAt) return;
    const t = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(t);
  }, [settings?.account, load]);

  if (loadFailed) {
    return (
      <section className="rounded-xl border border-border-light p-4 dark:border-border-dark/60">
        <p className="text-sm">Your mailbox settings could not be loaded.</p>
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => void load()}><RefreshCw size={14} /> Try again</Button>
      </section>
    );
  }
  if (!settings) {
    return (
      <section className="space-y-2 rounded-xl border border-border-light p-4 dark:border-border-dark/60" aria-busy="true" aria-label="Loading your mailbox settings">
        <Skeleton className="h-4 w-1/3" /><Skeleton className="h-3 w-2/3" /><Skeleton className="h-9 w-full" />
      </section>
    );
  }

  const acct = settings.account;

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('connect'); setError(null);
    try {
      const account = await api.connectMailAccount({ address: address.trim(), password, sendAs });
      setPassword('');
      setSettings({ ...settings, account });
      confirmed('Mailbox connected', { body: 'Your recent email is coming in now.' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect.');
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async () => {
    setBusy('sync');
    try {
      await api.syncMailAccount();
      confirmed('Checking for new email');
      setTimeout(() => { void load(); }, 2500);
    } catch (err) {
      notify({ title: 'Could not check for email', body: err instanceof Error ? err.message : undefined, tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (patch: { sendAs?: boolean; paused?: boolean }) => {
    setBusy('toggle');
    try {
      const account = await api.updateMailAccount(patch);
      setSettings({ ...settings, account });
      confirmed(patch.paused === true ? 'Syncing paused' : patch.paused === false ? 'Syncing resumed'
        : account.sendAs ? 'Replies will come from your address' : 'Replies will come from Tupo');
    } catch (err) {
      notify({ title: 'Could not change that', body: err instanceof Error ? err.message : undefined, tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: 'Disconnect your mailbox?',
      body: 'Tupo deletes your saved password at once and stops reading your mailbox. Your real mailbox is not touched.',
      confirmLabel: 'Disconnect', tone: 'danger',
    });
    if (!ok) return;
    const purge = await confirm({
      title: 'Also remove the imported email from Tupo?',
      body: `${acct?.importedCount ?? 0} message(s) were brought in from your mailbox. They stay in your real mailbox either way.`,
      confirmLabel: 'Remove them', cancelLabel: 'Keep them',
    });
    setBusy('disconnect');
    try {
      await api.disconnectMailAccount(purge);
      setSettings({ ...settings, account: null });
      confirmed('Mailbox disconnected');
    } catch (err) {
      notify({ title: 'Could not disconnect', body: err instanceof Error ? err.message : undefined, tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-xl border border-border-light p-4 dark:border-border-dark/60" data-testid="connected-mailbox">
      {dialog}
      <div className="mb-1 flex items-center gap-2">
        <AtSign size={16} className="text-blue-600 dark:text-blue-400" />
        <h2 className="text-sm font-semibold">School mailbox</h2>
      </div>
      <p className="mb-3 text-xs text-text-secondary-light dark:text-text-secondary-dark">
        See the email you receive from outside Tupo here, and reply as your own address. Tupo only reads your mailbox: nothing there is moved, deleted or marked read.
      </p>

      {!settings.available ? (
        <p className="rounded-lg bg-surface-light px-3 py-2 text-xs text-text-secondary-light dark:bg-card-dark/50 dark:text-text-secondary-dark">
          {settings.unavailableReason}
        </p>
      ) : acct ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-light px-3 py-2 dark:bg-card-dark/50">
            {acct.status === 'error'
              ? <AlertTriangle size={16} className="shrink-0 text-amber-600" />
              : acct.status === 'paused'
                ? <PauseCircle size={16} className="shrink-0 text-text-secondary-light" />
                : <CheckCircle2 size={16} className="shrink-0 text-blue-600 dark:text-blue-400" />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" data-testid="mailbox-address">{acct.address}</p>
              <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark" data-testid="mailbox-status">
                {acct.status === 'paused' ? 'Paused' : acct.lastSyncAt ? `Checked ${ago(acct.lastSyncAt)}` : 'Bringing in your recent email…'}
                {' · '}{acct.importedCount} imported
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void syncNow()} disabled={busy !== null || acct.status === 'paused'}>
              {busy === 'sync' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Sync now
            </Button>
          </div>
          {acct.lastError && (
            <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              {acct.lastError}
            </p>
          )}
          <label className={`flex items-start gap-2 text-sm ${acct.canSend ? '' : 'opacity-60'}`}>
            <input type="checkbox" className="mt-0.5 accent-blue-600" checked={acct.sendAs} disabled={!acct.canSend || busy !== null}
              onChange={(e) => void toggle({ sendAs: e.target.checked })} />
            <span>
              <span className="font-medium">Send my replies from {acct.address}</span>
              <span className="block text-xs text-text-secondary-light dark:text-text-secondary-dark">
                {acct.canSend
                  ? 'People outside Tupo see your own address, and their answers come back here.'
                  : 'The mail server did not allow sending with this login, so mail goes out through Tupo.'}
              </span>
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => void toggle({ paused: acct.status !== 'paused' })} disabled={busy !== null}>
              {acct.status === 'paused' ? <><PlayCircle size={14} /> Resume syncing</> : <><PauseCircle size={14} /> Pause syncing</>}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void disconnect()} disabled={busy !== null}>
              {busy === 'disconnect' ? <Loader2 size={14} className="animate-spin" /> : <Unplug size={14} />} Disconnect
            </Button>
          </div>
          {acct.status === 'error' && (
            <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark">Changed your email password? Disconnect, then connect again with the new one.</p>
          )}
        </div>
      ) : (
        <form onSubmit={(e) => void connect(e)} className="space-y-3" aria-label="Connect your school mailbox">
          <div>
            <label htmlFor="mb-address" className="mb-1 block text-xs font-medium">Email address</label>
            <input id="mb-address" type="email" autoComplete="username" required value={address} onChange={(e) => setAddress(e.target.value)}
              placeholder={settings.domain ? `you@${settings.domain}` : 'you@school.org'}
              className="w-full rounded-lg border border-border-light bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-border-dark/60 dark:bg-card-dark" />
          </div>
          <div>
            <label htmlFor="mb-password" className="mb-1 block text-xs font-medium">Email password</label>
            <div className="flex items-center rounded-lg border border-border-light bg-white focus-within:border-blue-500 dark:border-border-dark/60 dark:bg-card-dark">
              <input id="mb-password" type={showPw ? 'text' : 'password'} autoComplete="current-password" required value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none" />
              <button type="button" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? 'Hide password' : 'Show password'}
                className="grid h-9 w-9 place-items-center text-text-secondary-light dark:text-text-secondary-dark">
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <p className="mt-1 text-xs text-text-secondary-light dark:text-text-secondary-dark">
              The password of your mailbox on {settings.imapHost}, not your Tupo sign-in. It is checked with the mail server, then kept encrypted.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-blue-600" checked={sendAs} onChange={(e) => setSendAs(e.target.checked)} />
            Send my replies from this address
          </label>
          {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <Button type="submit" disabled={busy !== null || !address || !password}>
            {busy === 'connect' ? <><Loader2 size={14} className="animate-spin" /> Checking with the mail server…</> : <><AtSign size={14} /> Connect mailbox</>}
          </Button>
        </form>
      )}
      {settings.replyCapture && (
        <p className="mt-3 text-xs text-text-secondary-light dark:text-text-secondary-dark">
          Replies from outside to your Tupo mail come back into the conversation, whether or not you connect a mailbox.
        </p>
      )}
    </section>
  );
};
