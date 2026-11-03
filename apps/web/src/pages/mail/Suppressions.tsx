import React, { useEffect, useState } from 'react';
import { Ban, Plus, Trash2 } from 'lucide-react';
import { Button, IconButton, SearchInput, Spinner } from '../../components/ui';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { useNotify } from '../../context/NotificationContext';
import * as api from './api';

const REASON: Record<string, string> = {
  bounce: 'Bounced', complaint: 'Marked as spam', manual: 'Added by staff', unsubscribe: 'Unsubscribed',
};

/**
 * The do-not-email list (FR-MAIL-7): addresses that bounced, unsubscribed or
 * were added by hand. Email copies to them are skipped; in-app mail is not.
 */
export const Suppressions: React.FC = () => {
  const { notify } = useNotify();
  const [confirm, dialog] = useConfirmDialog();
  const [rows, setRows] = useState<api.MailSuppression[] | null>(null);
  const [q, setQ] = useState('');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = (query = q) => api.listSuppressions(query).then(setRows).catch(() => setRows([]));
  useEffect(() => {
    const t = setTimeout(() => load(q), 250);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.addSuppression(address.trim(), note.trim());
      notify({ title: `${address.trim()} will not be emailed`, tone: 'success' });
      setAddress(''); setNote('');
      await load();
    } catch (err) {
      notify({ title: 'Could not add the address', body: err instanceof Error ? err.message : undefined, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: api.MailSuppression) => {
    const ok = await confirm({
      title: `Email ${s.address} again?`,
      body: 'Campaigns and email copies will reach this address again.',
      warning: s.reason === 'unsubscribe' || s.reason === 'complaint'
        ? 'This person asked not to be emailed. Only remove it if they asked to be added back.'
        : undefined,
      confirmLabel: 'Remove from list',
      tone: s.reason === 'unsubscribe' || s.reason === 'complaint' ? 'danger' : 'default',
    });
    if (!ok) return;
    try {
      await api.removeSuppression(s.address);
      await load();
    } catch (err) {
      notify({ title: 'Could not remove the address', body: err instanceof Error ? err.message : undefined, tone: 'error' });
    }
  };

  return (
    <section aria-labelledby="suppressions-title" className="mt-8">
      <h2 id="suppressions-title" className="mb-1 flex items-center gap-2 text-base font-semibold"><Ban size={16} /> Do-not-email list</h2>
      <p className="mb-3 text-sm text-text-secondary-light dark:text-text-secondary-dark">
        Addresses that bounced, unsubscribed or were added here get no email copies. Mail inside Tupo still reaches them.
      </p>
      <form onSubmit={add} className="mb-3 flex flex-wrap items-center gap-2">
        <input type="email" required value={address} onChange={(e) => setAddress(e.target.value)} placeholder="name@example.com"
          aria-label="Address to stop emailing"
          className="min-w-0 flex-1 rounded-lg border border-border-light bg-white px-3 py-1.5 text-sm dark:border-border-dark/50 dark:bg-chrome-dark" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (optional)" aria-label="Why"
          className="min-w-0 flex-1 rounded-lg border border-border-light bg-white px-3 py-1.5 text-sm dark:border-border-dark/50 dark:bg-chrome-dark" />
        <Button size="sm" type="submit" disabled={busy || !address.trim()}><Plus size={13} /> Add</Button>
      </form>
      <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search addresses" aria-label="Search the do-not-email list" />
      {rows === null ? <div className="grid place-items-center py-6"><Spinner /></div>
        : rows.length === 0 ? <p className="py-4 text-sm text-text-secondary-light">{q ? 'No address matches.' : 'Nobody is on the list.'}</p>
        : (
          <ul className="mt-2 divide-y divide-border-light rounded-xl border border-border-light dark:divide-border-dark/40 dark:border-border-dark/50">
            {rows.map((s) => (
              <li key={s.address} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.address}</span>
                  <span className="block truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">
                    {REASON[s.reason] ?? s.reason} · {new Date(s.created_at).toLocaleDateString()}{s.note && ` · ${s.note}`}
                  </span>
                </span>
                <IconButton label={`Remove ${s.address}`} size="sm" onClick={() => void remove(s)}><Trash2 size={15} /></IconButton>
              </li>
            ))}
          </ul>
        )}
      {dialog}
    </section>
  );
};
