import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, ExternalLink, Loader2 } from 'lucide-react';
import type { AiHandoffPayload } from '@tupo/shared';
import { apiGet, apiPost, SESSION_KEY } from '../lib/api';
import { handoffDestination, type AiHandoffRequest, type HandoffTarget } from '../lib/handoff';

/**
 * "Open in my AI ▾" + "Paste the answer" (EXTERNAL_AI_CONTRACT.md §1 UI).
 *
 * A person's own Claude / ChatGPT / Gemini can never be called by Tupo (vendor
 * terms), so Tupo hands them its exact prompt instead: prefilled in a new tab
 * when it fits a link (never auto-submitted), otherwise copied to the
 * clipboard. They paste the reply back and it goes through the same checks as
 * a school AI answer ("via your own AI (pasted)"). Shown only when the school
 * offers it to this person (GET /api/ai/external).
 */

const FRESH_MS = 60_000;
let cached: { at: number; on: boolean } | null = null;
let inflight: Promise<boolean> | null = null;

function loadOffered(): Promise<boolean> {
  if (!localStorage.getItem(SESSION_KEY)) return Promise.resolve(false);
  if (cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.on);
  inflight ??= apiGet<{ handoff: boolean }>('/api/ai/external')
    .then((r) => !!r.data?.handoff)
    .catch(() => false)
    .then((on) => { cached = { at: Date.now(), on }; return on; })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Is "Open in my AI" offered to the signed-in person? (shared across panels, 60 s) */
export function useHandoffOffered(): boolean {
  const [on, setOn] = useState<boolean>(cached?.on ?? false);
  useEffect(() => {
    let live = true;
    void loadOffered().then((v) => { if (live) setOn(v); });
    return () => { live = false; };
  }, []);
  return on;
}

/** Calls an AI endpoint in prompt mode: the exact prompt, no AI is called. */
export async function handoffPrompt(path: string, body: Record<string, unknown>, pupilConsent: boolean): Promise<AiHandoffPayload> {
  const aiHandoff: AiHandoffRequest = { mode: 'prompt', ...(pupilConsent ? { pupilConsent: true } : {}) };
  const r = (await apiPost<unknown>(path, { ...body, aiHandoff })) as unknown as { handoff?: AiHandoffPayload };
  if (!r.handoff?.prompt) throw new Error('Could not prepare the prompt.');
  return r.handoff;
}

/** The `aiHandoff` for an import call with the pasted answer. */
export const importHandoff = (text: string): AiHandoffRequest => ({ mode: 'import', text });

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const TARGETS: { key: HandoffTarget; label: string }[] = [
  { key: 'claude', label: 'Claude' },
  { key: 'chatgpt', label: 'ChatGPT' },
  { key: 'gemini', label: 'Gemini' },
  { key: 'copy', label: 'Copy the prompt' },
];

export const HandoffControl: React.FC<{
  /** Calls the AI endpoint in prompt mode (see handoffPrompt). */
  requestPrompt: (pupilConsent: boolean) => Promise<AiHandoffPayload>;
  /** Calls the endpoint in import mode with the pasted answer and shows the result; throws to show an error. */
  importAnswer: (text: string) => Promise<void>;
  /** The prompt can include pupils' names or words: offer "Include pupil details" (unticked). */
  pupilData?: boolean;
  disabled?: boolean;
  label?: string;
  /** Sits on the dark meeting panel. */
  onDark?: boolean;
  /** Which way the menu opens. */
  menu?: 'up' | 'down';
  className?: string;
}> = ({ requestPrompt, importAnswer, pupilData, disabled, label = 'Open in my AI', onDark = false, menu = 'down', className = '' }) => {
  const offered = useHandoffOffered();
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<{ payload: AiHandoffPayload; url: string | null; copied: boolean } | null>(null);
  const [answer, setAnswer] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!offered) return null;

  const go = async (target: HandoffTarget) => {
    setOpen(false); setError(null); setBusy(true);
    try {
      const payload = await requestPrompt(consent);
      const dest = handoffDestination(target, payload.prompt);
      const copied = dest.copy ? await copyText(payload.prompt) : false;
      // A new tab, without access back to Tupo; nothing is submitted for the person.
      if (dest.url) window.open(dest.url, '_blank', 'noopener,noreferrer');
      setHandoff({ payload, url: dest.url, copied });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare the prompt.');
    } finally { setBusy(false); }
  };

  const submit = async () => {
    if (!answer.trim()) return;
    setError(null); setBusy(true);
    try {
      await importAnswer(answer);
      setAnswer(''); setHandoff(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not use that answer.');
    } finally { setBusy(false); }
  };

  const muted = onDark ? 'text-white/60' : 'text-text-secondary-light dark:text-text-secondary-dark';
  const field = onDark
    ? 'border-white/15 bg-white/5 text-white placeholder:text-white/40'
    : 'border-border-light bg-white dark:border-border-dark/60 dark:bg-transparent';

  return (
    <div ref={ref} className={`relative ${className}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button type="button" aria-haspopup="menu" aria-expanded={open} disabled={disabled || busy}
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] disabled:opacity-50 ${
            onDark ? 'text-white/70 hover:bg-white/10 hover:text-white' : 'text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark'
          }`}>
          {busy && !handoff ? <Loader2 size={11} className="animate-spin" /> : <ExternalLink size={11} />}
          {label} <ChevronDown size={11} />
        </button>
        {pupilData && (
          <label className={`inline-flex items-center gap-1 text-[11px] ${muted}`}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="accent-blue-600" />
            Include pupil details
          </label>
        )}
      </div>
      {open && (
        <div role="menu"
          className={`absolute left-0 z-50 w-48 ${menu === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} overflow-hidden rounded-xl border border-border-light bg-white py-1 shadow-xl dark:border-border-dark/50 dark:bg-elevated-dark`}>
          {TARGETS.map((t) => (
            <button key={t.key} type="button" role="menuitem" onClick={() => go(t.key)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-surface-dark">
              {t.key === 'copy' ? <Copy size={12} /> : <ExternalLink size={12} />} {t.label}
            </button>
          ))}
        </div>
      )}
      {handoff && (
        <div className="mt-1.5 space-y-1.5">
          <p className={`text-[11px] ${muted}`}>
            {handoff.url
              ? handoff.copied
                ? 'The prompt is copied: paste it into the chat that opened, send it, then paste the whole reply here.'
                : 'Send the prompt in the chat that opened, then paste the whole reply here.'
              : handoff.copied
                ? 'The prompt is copied. Paste it into your AI, then paste the whole reply here.'
                : 'Copy the prompt below into your AI, then paste the whole reply here.'}{' '}
            {handoff.url && (
              <a href={handoff.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">Open again</a>
            )}
            {!handoff.copied && (
              <button type="button" onClick={() => void copyText(handoff.payload.prompt)} className="ml-2 text-blue-600 hover:underline dark:text-blue-400">
                Copy the prompt
              </button>
            )}
          </p>
          {!handoff.copied && !handoff.url && (
            <textarea readOnly value={handoff.payload.prompt} rows={3} aria-label="The prompt for your AI"
              className={`w-full resize-none rounded-lg border px-2 py-1.5 text-xs ${field}`} />
          )}
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={4} aria-label="Paste the answer"
            placeholder={handoff.payload.expects === 'json' ? 'Paste the answer: the whole reply, including the ```json block' : 'Paste the answer'}
            className={`w-full resize-y rounded-lg border px-2 py-1.5 text-xs ${field}`} />
          <div className="flex items-center gap-2">
            <button type="button" onClick={submit} disabled={busy || !answer.trim()}
              className="inline-flex items-center gap-1 rounded-full bg-blue-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">
              {busy ? <Loader2 size={12} className="animate-spin" /> : null} Use this answer
            </button>
            <button type="button" onClick={() => { setHandoff(null); setAnswer(''); setError(null); }} disabled={busy}
              className={`text-xs ${muted}`}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
};
