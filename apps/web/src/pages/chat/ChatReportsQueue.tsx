import React, { useCallback, useEffect, useState } from 'react';
import { Check, ShieldCheck, X } from 'lucide-react';
import { Avatar, EmptyState, Spinner } from '../../components/ui';
import { useNotify } from '../../context/NotificationContext';
import { usePermissions } from '../../hooks/usePermissions';
import * as chatApi from './api';

/**
 * Reports about people and chat messages (B-05), for moderators. Each shows
 * the message as it was when reported, how many earlier reports the person
 * has, and — for MODERATION_ACT — resolve or dismiss with an optional note.
 * The reporter is told it was reviewed; never what was done.
 */

const REASON_LABEL: Record<chatApi.ReportReason, string> = {
  harassment: 'Bullying or harassment',
  inappropriate: 'Inappropriate',
  spam: 'Spam',
  safety: 'Someone may be at risk',
  other: 'Other',
};

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

export const ChatReportsQueue: React.FC = () => {
  const { can } = usePermissions();
  const { notify } = useNotify();
  const [tab, setTab] = useState<'open' | 'resolved' | 'dismissed'>('open');
  const [reports, setReports] = useState<chatApi.ChatReport[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const reload = useCallback(() => {
    setReports(null);
    chatApi.listReports(tab).then(setReports).catch(() => setReports([]));
  }, [tab]);
  useEffect(reload, [reload]);

  const act = async (r: chatApi.ChatReport, status: 'resolved' | 'dismissed') => {
    try {
      await chatApi.resolveReport(r.id, status, notes[r.id]?.trim() || undefined);
      setReports((prev) => prev?.filter((x) => x.id !== r.id) ?? null);
    } catch (err) {
      notify({ title: 'Could not update the report', body: err instanceof Error ? err.message : undefined, tone: 'error' });
    }
  };

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-border-light dark:border-border-dark/40">
        {(['open', 'resolved', 'dismissed'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-semibold capitalize ${
            tab === t ? 'border-b-2 border-blue-600 text-blue-600 dark:text-blue-400' : 'text-text-secondary-light dark:text-text-secondary-dark'
          }`}>{t}</button>
        ))}
      </div>
      {!reports ? <div className="py-10 text-center"><Spinner /></div>
        : reports.length === 0 ? <EmptyState title={tab === 'open' ? 'No chat reports waiting' : `No ${tab} reports`} />
        : (
          <ul className="space-y-3">
            {reports.map((r) => (
              <li key={r.id} className={`rounded-2xl border bg-card-light p-4 dark:bg-elevated-dark/40 ${
                r.reason === 'safety' ? 'border-red-300 dark:border-red-500/50' : 'border-border-light dark:border-border-dark/40'
              }`}>
                <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                  <span className="rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300">{REASON_LABEL[r.reason] ?? r.reason}</span>
                  <span>{r.messageId ? 'Message' : 'Person'}</span>
                  <span>· reported by {r.reporter.name}</span>
                  <span>· {ago(r.createdAt)}</span>
                </div>
                {r.reported && (
                  <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
                    <Avatar name={r.reported.name} src={r.reported.avatarUrl ?? undefined} size={22} />
                    {r.reported.name}
                    {r.priorReports > 0 && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                        {r.priorReports} earlier {r.priorReports === 1 ? 'report' : 'reports'}
                      </span>
                    )}
                  </p>
                )}
                {r.details && <p className="mt-1.5 text-xs italic text-text-secondary-light dark:text-text-secondary-dark">“{r.details}”</p>}
                {r.messageExcerpt !== null && (
                  <blockquote className="mt-2 whitespace-pre-wrap break-words rounded-xl border border-border-light bg-surface-light p-3 text-sm text-text-primary-light dark:border-border-dark/50 dark:bg-card-dark/40 dark:text-text-primary-dark">
                    {r.messageExcerpt || '(no text — an attachment)'}
                  </blockquote>
                )}
                {tab !== 'open' && r.resolutionNote && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                    <ShieldCheck size={12} /> {r.resolutionNote}
                  </p>
                )}
                {tab === 'open' && can('MODERATION_ACT') && (
                  <div className="mt-3 space-y-2">
                    <input
                      value={notes[r.id] ?? ''} placeholder="Note for the record (optional)"
                      onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value.slice(0, 1000) }))}
                      className="w-full rounded-xl border border-border-light bg-white px-3 py-1.5 text-xs outline-none focus:border-blue-500 dark:border-border-dark/40 dark:bg-card-dark dark:text-text-primary-dark"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => void act(r, 'resolved')} className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"><Check size={13} /> Resolved</button>
                      <button onClick={() => void act(r, 'dismissed')} className="inline-flex items-center gap-1.5 rounded-full border border-border-light px-3 py-1.5 text-xs font-semibold text-text-secondary-light hover:bg-surface-light dark:border-border-dark/60 dark:text-text-secondary-dark"><X size={13} /> Dismiss</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
};
