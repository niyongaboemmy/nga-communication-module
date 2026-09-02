import React, { useEffect, useState } from 'react';
import { X, CheckCheck, AlertTriangle, Loader2, Ban, Mail } from 'lucide-react';
import { Spinner } from '../../components/ui';
import * as api from './api';
import type { MailRecipientDelivery } from '@tupo/shared';

const STATUS_ICON: Record<string, React.ReactNode> = {
  delivered: <CheckCheck size={14} className="text-emerald-500" />,
  sent: <CheckCheck size={14} className="text-text-secondary-light" />,
  queued: <Loader2 size={12} className="animate-spin text-text-secondary-light" />,
  sending: <Loader2 size={12} className="animate-spin text-blue-500" />,
  bounced: <AlertTriangle size={14} className="text-red-500" />,
  failed: <AlertTriangle size={14} className="text-red-500" />,
  suppressed: <Ban size={14} className="text-amber-500" />,
};

export const DeliverySheet: React.FC<{ messageId: string; onClose: () => void }> = ({ messageId, onClose }) => {
  const [rows, setRows] = useState<MailRecipientDelivery[] | null>(null);

  useEffect(() => {
    let live = true;
    const tick = () => api.getDelivery(messageId).then((r) => { if (live) setRows(r); }).catch(() => {});
    tick();
    const iv = setInterval(tick, 5000);
    return () => { live = false; clearInterval(iv); };
  }, [messageId]);

  const summary = rows?.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {}) ?? {};

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl dark:bg-elevated-dark" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border-light px-4 py-3 dark:border-border-dark/60">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Mail size={16} /> Delivery tracking</h3>
          <button aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>

        {!rows ? (
          <div className="grid flex-1 place-items-center"><Spinner /></div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 border-b border-border-light px-4 py-3 text-xs dark:border-border-dark/60">
              {Object.entries(summary).map(([k, v]) => (
                <span key={k} className="inline-flex items-center gap-1 rounded-full bg-surface-light px-2 py-1 dark:bg-surface-dark">
                  {STATUS_ICON[k]} {v} {k}
                </span>
              ))}
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {rows.map((r) => (
                <li key={r.recipientId} className="border-b border-border-light/60 px-4 py-3 dark:border-border-dark/30">
                  <div className="flex items-center gap-2">
                    {STATUS_ICON[r.status] ?? <span className="h-2 w-2 rounded-full bg-slate-400" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.name}</span>
                      <span className="block truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">{r.address}</span>
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-secondary-light">{r.kind} · {r.channel === 'smtp' ? 'email' : 'in-app'}</span>
                  </div>
                  {r.error && <p className="mt-1 text-xs text-red-600">{r.error}</p>}
                  {r.events.length > 0 && (
                    <ol className="mt-1.5 space-y-0.5 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                      {r.events.map((e, i) => (
                        <li key={i}>{e.type} — {new Date(e.at).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
};
