import React, { useState } from 'react';
import { Sparkles, Wand2, X, Loader2, Check, Undo2, ArrowUpRight } from 'lucide-react';
import { Button } from '../../components/ui';
import * as api from './api';
import type { MailAiAction } from '@tupo/shared';

/** Strip HTML to text for the model — cheap and good enough for a prompt. */
export const htmlToPlain = (html: string) =>
  html.replace(/<(br|\/p|\/div|\/li|\/h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').trim();

interface Props {
  getCurrentHtml: () => string;
  subject: string;
  recipients: string[];        // display names
  threadId?: string;           // present when replying
  onApply: (html: string, note: string) => void;
  onClose: () => void;
}

const QUICK: Array<{ action: MailAiAction; label: string; needsText: boolean }> = [
  { action: 'improve', label: 'Improve writing', needsText: true },
  { action: 'concise', label: 'Shorten', needsText: true },
  { action: 'expand', label: 'Expand notes', needsText: true },
  { action: 'formal', label: 'More formal', needsText: true },
  { action: 'friendly', label: 'Friendlier', needsText: true },
  { action: 'grammar', label: 'Fix grammar', needsText: true },
];

export const AiAssistant: React.FC<Props> = ({ getCurrentHtml, subject, recipients, threadId, onApply, onClose }) => {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ html: string; note: string; provider: string } | null>(null);
  const [translateOpen, setTranslateOpen] = useState(false);

  const run = async (action: MailAiAction, extra?: string) => {
    setBusy(action); setError(null); setResult(null);
    try {
      const currentText = htmlToPlain(getCurrentHtml());
      const r = await api.aiCompose({
        action,
        instruction: extra ?? (action === 'draft' || action === 'reply' ? instruction : undefined),
        currentText,
        subject,
        recipients,
        threadId: action === 'reply' ? threadId : undefined,
      });
      setResult({ html: r.html, note: r.note, provider: r.providerUsed });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The assistant could not help with that.');
    } finally {
      setBusy(null);
    }
  };

  const hasText = htmlToPlain(getCurrentHtml()).length > 0;

  return (
    <div className="absolute bottom-full left-0 z-20 mb-2 w-[22rem] rounded-xl border border-border-light bg-white p-3 shadow-xl dark:border-border-dark dark:bg-elevated-dark">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={15} className="text-blue-600" />
        <span className="text-sm font-semibold">AI assistant</span>
        <button aria-label="Close" className="ml-auto" onClick={onClose}><X size={15} /></button>
      </div>

      {!result && (
        <>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={2}
            placeholder={threadId ? 'Draft a reply that… (optional)' : 'Tell the assistant what to write…'}
            className="w-full resize-none rounded-lg border border-border-light bg-transparent px-2.5 py-2 text-sm outline-none focus:border-blue-400 dark:border-border-dark/60"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {threadId && (
              <button onClick={() => run('reply')} disabled={!!busy}
                className="inline-flex items-center gap-1 rounded-full bg-blue-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">
                {busy === 'reply' ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />} Draft reply
              </button>
            )}
            {!threadId && (
              <button onClick={() => run('draft')} disabled={!!busy || !instruction.trim()}
                className="inline-flex items-center gap-1 rounded-full bg-blue-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">
                {busy === 'draft' ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />} Write it
              </button>
            )}
          </div>

          <div className="mt-3 border-t border-border-light pt-2 dark:border-border-dark/50">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-text-secondary-light">Rewrite what I have</p>
            <div className="flex flex-wrap gap-1.5">
              {QUICK.map((q) => (
                <button key={q.action} onClick={() => run(q.action)} disabled={!!busy || (q.needsText && !hasText)}
                  className="rounded-full border border-border-light px-2.5 py-1 text-xs disabled:opacity-40 hover:border-blue-400 dark:border-border-dark/60">
                  {busy === q.action ? <Loader2 size={12} className="animate-spin" /> : q.label}
                </button>
              ))}
              <button onClick={() => setTranslateOpen((v) => !v)} disabled={!hasText}
                className="rounded-full border border-border-light px-2.5 py-1 text-xs disabled:opacity-40 hover:border-blue-400 dark:border-border-dark/60">
                Translate…
              </button>
            </div>
            {translateOpen && (
              <div className="mt-2 flex gap-1.5">
                {['Kinyarwanda', 'French', 'English', 'Swahili'].map((lang) => (
                  <button key={lang} onClick={() => run('translate', lang)} disabled={!!busy}
                    className="rounded-lg bg-surface-light px-2 py-1 text-xs dark:bg-surface-dark">{lang}</button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {error && <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">{error}</p>}

      {result && (
        <div>
          <p className="mb-1 text-xs text-text-secondary-light dark:text-text-secondary-dark">{result.note} · via {result.provider}</p>
          <div className="tupo-prose max-h-52 overflow-y-auto rounded-lg border border-border-light bg-surface-light/50 p-2.5 text-sm dark:border-border-dark/60 dark:bg-surface-dark/40"
            dangerouslySetInnerHTML={{ __html: result.html }} />
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" onClick={() => { onApply(result.html, result.note); onClose(); }}>
              <Check size={13} /> Use this
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setResult(null)}><Undo2 size={13} /> Back</Button>
          </div>
        </div>
      )}
    </div>
  );
};
