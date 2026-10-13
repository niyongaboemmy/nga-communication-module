import React, { useEffect, useRef, useState } from 'react';
import { Flag, X } from 'lucide-react';
import { Button, IconButton } from '../../components/ui';
import { useNotify } from '../../context/NotificationContext';
import * as chatApi from './api';

/**
 * Report a person or one of their messages (B-05, FR-USR-7).
 *
 * Short on purpose: a reason, an optional line of context, and the choice to
 * block them at the same time. The report goes to the moderators with a copy of
 * the message as it is now, so editing or deleting it later changes nothing.
 * The reported person is never told who reported them.
 */

const REASONS: Array<{ value: chatApi.ReportReason; label: string; hint: string }> = [
  { value: 'harassment', label: 'Bullying or harassment', hint: 'Unkind, threatening or targeting someone' },
  { value: 'inappropriate', label: 'Inappropriate content', hint: 'Not suitable for school' },
  { value: 'spam', label: 'Spam', hint: 'Repeated or unwanted messages' },
  { value: 'safety', label: 'Someone may be at risk', hint: 'A safeguarding concern' },
  { value: 'other', label: 'Something else', hint: 'Tell the moderators below' },
];

export const ReportDialog: React.FC<{
  user: { id: string; name: string };
  /** Reporting one message rather than the person. */
  message?: { id: string; conversationId: string };
  /** Already blocked: don't offer it again. */
  alreadyBlocked?: boolean;
  onClose: () => void;
  onBlocked?: () => void;
}> = ({ user, message, alreadyBlocked, onClose, onBlocked }) => {
  const { notify } = useNotify();
  const [reason, setReason] = useState<chatApi.ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => { firstRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const submit = async () => {
    if (!reason || busy) return;
    setBusy(true);
    try {
      const r = await chatApi.submitReport({
        userId: user.id,
        ...(message ? { messageId: message.id, conversationId: message.conversationId } : {}),
        reason,
        details: details.trim() || undefined,
        alsoBlock: alsoBlock && !alreadyBlocked,
      });
      if (alsoBlock && !alreadyBlocked) onBlocked?.();
      notify({
        title: r.duplicate ? 'You have already reported this' : 'Thank you — the moderators will look at it',
        body: alsoBlock && !alreadyBlocked ? `${user.name} is also blocked.` : undefined,
        tone: 'success',
      });
      onClose();
    } catch (err) {
      notify({ title: 'Could not send the report', body: err instanceof Error ? err.message : undefined, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-90 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-title"
        className="relative flex max-h-[85vh] w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl dark:border-border-dark/40 dark:bg-chrome-dark"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border-light px-4 py-3 dark:border-border-dark/30">
          <h2 id="report-title" className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
            <Flag size={15} className="text-red-500" />
            {message ? 'Report message' : `Report ${user.name}`}
          </h2>
          <IconButton label="Close" size="sm" onClick={onClose}><X size={15} /></IconButton>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-xs text-text-secondary-light dark:text-text-secondary-dark">
              What is wrong{message ? ' with this message' : ''}?
            </legend>
            {REASONS.map((r, i) => (
              <label
                key={r.value}
                className={`flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2 transition-colors ${
                  reason === r.value
                    ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-500/10'
                    : 'border-border-light hover:bg-surface-light dark:border-border-dark/40 dark:hover:bg-surface-dark'
                }`}
              >
                <input
                  ref={i === 0 ? firstRef : undefined}
                  type="radio" name="report-reason" value={r.value}
                  checked={reason === r.value} onChange={() => setReason(r.value)}
                  className="mt-0.5 accent-blue-600"
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-text-primary-light dark:text-text-primary-dark">{r.label}</span>
                  <span className="block text-[11px] text-text-secondary-light dark:text-text-secondary-dark">{r.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="block">
            <span className="mb-1 block text-xs text-text-secondary-light dark:text-text-secondary-dark">Anything the moderators should know? (optional)</span>
            <textarea
              value={details} onChange={(e) => setDetails(e.target.value.slice(0, 2000))} rows={3}
              className="w-full resize-none rounded-xl border border-border-light bg-white px-3 py-2 text-sm text-text-primary-light outline-none focus:border-blue-500 dark:border-border-dark/40 dark:bg-card-dark dark:text-text-primary-dark"
            />
          </label>

          {!alreadyBlocked && (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-text-primary-light dark:text-text-primary-dark">
              <input type="checkbox" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} className="accent-blue-600" />
              Also block {user.name.split(' ')[0]} — they won’t be able to message you
            </label>
          )}
          <p className="text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
            {user.name.split(' ')[0]} won’t be told who reported them.
          </p>
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-border-light px-4 py-3 dark:border-border-dark/30">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={!reason || busy}>{busy ? 'Sending…' : 'Send report'}</Button>
        </footer>
      </div>
    </div>
  );
};
