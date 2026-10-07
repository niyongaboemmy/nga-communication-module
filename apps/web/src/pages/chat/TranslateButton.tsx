import React, { useEffect, useState } from 'react';
import { Languages, X } from 'lucide-react';
import { Spinner } from '../../components/ui';
import { useNotify } from '../../context/NotificationContext';
import * as chatApi from './api';
import { TRANSLATION_LANGUAGES } from './api';
import type { LanguageCode } from './api';

/**
 * Translate one message in place (FR-MSG-25).
 *
 * Shown *under* the original rather than replacing it, and dismissible. A
 * translation that hides what was actually written is a problem in a school:
 * the original is the record, and a parent or a moderator reading back needs to
 * see the words that were typed, not a machine's rendering of them.
 *
 * It is also labelled as machine translation, for the same reason.
 */

export const TranslateControl: React.FC<{
  conversationId: string;
  messageId: string;
  onDark: boolean;
  /** Bumped by the message's hover toolbar to open the language menu. */
  openSignal: number;
}> = ({ conversationId, messageId, onDark, openSignal }) => {
  const { notify } = useNotify();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ language: LanguageCode; text: string } | null>(null);
  useEffect(() => { if (openSignal > 0) setOpen(true); }, [openSignal]);

  const translate = async (language: LanguageCode) => {
    setOpen(false);
    setBusy(true);
    try {
      const r = await chatApi.translateMessage(conversationId, messageId, language);
      setResult({ language, text: r.text });
    } catch (err) {
      notify({
        title: 'Could not translate that',
        body: err instanceof Error ? err.message : undefined,
        tone: 'warning',
      });
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div
        className={`mt-1.5 rounded-lg border-l-2 py-1 pl-2 pr-1 text-sm ${
          onDark ? 'border-white/40' : 'border-blue-400'
        }`}
      >
        <p className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-wide opacity-70">
          <Languages size={9} />
          {TRANSLATION_LANGUAGES[result.language]} · machine translation
          <button
            onClick={() => setResult(null)}
            aria-label="Hide the translation"
            className="ml-auto rounded p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
          >
            <X size={10} />
          </button>
        </p>
        <p className="whitespace-pre-wrap">{result.text}</p>
      </div>
    );
  }

  // Nothing under the message until someone asks (from the hover toolbar).
  if (!open && !busy) return null;

  return (
    <span className="relative">
      {busy && (
        <span className={`mt-1 flex items-center gap-1 text-[11px] font-medium ${onDark ? 'text-white/80' : 'text-text-secondary-light dark:text-text-secondary-dark'}`}>
          <Spinner className="h-2.5 w-2.5" /> Translating…
        </span>
      )}

      {open && (
        <span
          role="menu"
          onMouseLeave={() => setOpen(false)}
          className="absolute left-0 top-full z-50 mt-1 w-40 overflow-hidden rounded-xl border border-border-light bg-white py-1 shadow-xl dark:border-border-dark/50 dark:bg-elevated-dark"
        >
          {(Object.entries(TRANSLATION_LANGUAGES) as Array<[LanguageCode, string]>).map(
            ([code, label]) => (
              <button
                key={code}
                role="menuitem"
                onClick={() => void translate(code)}
                className="block w-full px-3 py-1.5 text-left text-xs text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-surface-dark"
              >
                {label}
              </button>
            ),
          )}
        </span>
      )}
    </span>
  );
};
