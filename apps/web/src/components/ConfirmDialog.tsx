import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ShieldAlert } from 'lucide-react';

/**
 * An in-app "are you sure?" (F-11, F-12), in place of `window.confirm`: it
 * can say what will change and why it matters, follows the theme, and does
 * not freeze every other tab of the browser while it waits.
 *
 *   const [confirm, dialog] = useConfirmDialog();
 *   if (!(await confirm({ title: 'Suspend Ann?', confirmLabel: 'Suspend', tone: 'danger' }))) return;
 *   …
 *   return <>{…}{dialog}</>;
 */

export interface ConfirmOptions {
  title: string;
  body?: React.ReactNode;
  /** Shown highlighted under the body: the consequence people must not miss. */
  warning?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

interface Pending extends ConfirmOptions { resolve: (ok: boolean) => void }

export function useConfirmDialog(): [(o: ConfirmOptions) => Promise<boolean>, React.ReactNode] {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => {
    setPending({ ...o, resolve });
  }), []);
  const close = useCallback((ok: boolean) => {
    setPending((p) => { p?.resolve(ok); return null; });
  }, []);
  return [confirm, pending ? <ConfirmDialog {...pending} onClose={close} /> : null];
}

const ConfirmDialog: React.FC<ConfirmOptions & { onClose: (ok: boolean) => void }> = ({
  title, body, warning, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'default', onClose,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    // Cancel is focused first: Enter on a dangerous dialog should not do the
    // dangerous thing. A dialog that asks for something (a reason) marks its
    // field with data-autofocus, and that goes first instead.
    (ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? cancelRef.current)?.focus();
    const back = opener.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(false); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>('button, textarea, input, select')];
      const first = items[0]; const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (back instanceof HTMLElement) back.focus();
    };
  }, [onClose]);

  const Icon = tone === 'danger' ? ShieldAlert : AlertTriangle;
  return (
    <div className="fixed inset-0 z-100 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => onClose(false)} aria-hidden="true" />
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        className="animate-pop relative w-full max-w-md rounded-2xl border border-border-light bg-white p-5 shadow-2xl dark:border-border-dark/40 dark:bg-chrome-dark"
      >
        <div className="flex items-start gap-3">
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${
            tone === 'danger' ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300' : 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300'}`}>
            <Icon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="confirm-title" className="text-base font-semibold text-text-primary-light dark:text-text-primary-dark">{title}</h2>
            <div id="confirm-body" className="mt-1.5 space-y-2 text-sm text-text-secondary-light dark:text-text-secondary-dark">
              {body}
              {warning && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">{warning}</p>
              )}
            </div>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={() => onClose(false)}
            className="rounded-full border border-border-light px-4 py-2 text-sm font-medium text-text-primary-light hover:bg-surface-light dark:border-border-dark/50 dark:text-text-primary-dark dark:hover:bg-surface-dark"
          >
            {cancelLabel}
          </button>
          <button
            onClick={() => onClose(true)}
            className={`rounded-full px-4 py-2 text-sm font-medium text-white ${
              tone === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
