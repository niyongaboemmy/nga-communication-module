import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ExternalLink } from 'lucide-react';
import type { AiAnswer, MyAiRoutes } from '@tupo/shared';
import { apiGet, SESSION_KEY } from '../lib/api';

/**
 * My AI (PERSONAL_AI_PROVIDERS_PLAN §10, MY_AI_GATEWAY.md "UI in each app").
 *
 * People add their own AI keys in the NGA MIS. Here they only pick, for one
 * request, which AI answers ("Answers with: School AI ▾"), and see afterwards
 * which one did ("via My Claude · claude-sonnet-5-5"). Nothing shows for
 * anyone without a usable key, or while the school has My AI off.
 */

const OFF: MyAiRoutes = { enabled: false, choices: [] };
const FRESH_MS = 60_000;
let cached: { at: number; routes: MyAiRoutes } | null = null;
let inflight: Promise<MyAiRoutes> | null = null;

function loadRoutes(): Promise<MyAiRoutes> {
  // Only a signed-in session: a meeting guest's ticket would be refused (and dropped) here.
  if (!localStorage.getItem(SESSION_KEY)) return Promise.resolve(OFF);
  if (cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.routes);
  inflight ??= apiGet<MyAiRoutes>('/api/ai/my-routes')
    .then((r) => r.data ?? OFF)
    .catch(() => OFF)
    .then((routes) => { cached = { at: Date.now(), routes }; return routes; })
    .finally(() => { inflight = null; });
  return inflight;
}

/** The signed-in person's My AI route map for Tupo (shared across panels, 60 s). */
export function useMyAiRoutes(): MyAiRoutes {
  const [routes, setRoutes] = useState<MyAiRoutes>(cached?.routes ?? OFF);
  useEffect(() => {
    let live = true;
    void loadRoutes().then((r) => { if (live) setRoutes(r); });
    return () => { live = false; };
  }, []);
  return routes;
}

/** The MIS front end's My AI page (same base the apps switcher links to). */
export const myAiManageUrl = (): string => {
  const home = import.meta.env.VITE_MIS_HOME_URL ||
    (import.meta.env.VITE_MIS_LOGIN_URL || '').replace(/\/login\/?$/, '');
  return `${home.replace(/\/+$/, '')}/my-ai`;
};

const choiceValue = (c: { credentialId: number; model: string }) => `${c.credentialId}:${c.model}`;

/**
 * "Answers with: School AI ▾". `value` is the `aiRoute` to send: null means the
 * person's saved choice in My AI, "school" or "<credentialId>:<model>" a
 * one-off pick. Renders nothing unless My AI is on and the person has a key.
 */
export const AiSourceControl: React.FC<{
  value: string | null;
  onChange: (aiRoute: string | null) => void;
  /** Sits on the dark meeting panel. */
  onDark?: boolean;
  /** Which way the menu opens; "down" where the control sits near the top of a panel. */
  menu?: 'up' | 'down';
  className?: string;
}> = ({ value, onChange, onDark = false, menu = 'up', className = '' }) => {
  const routes = useMyAiRoutes();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!routes.enabled || routes.choices.length === 0) return null;

  // With no one-off pick, name what the person's saved routes would use.
  const saved = Object.values(routes.byTask ?? {}).find((t) => t.route === 'personal');
  const picked = value && value !== 'school' ? routes.choices.find((c) => choiceValue(c) === value) : null;
  const current = value === 'school'
    ? 'School AI'
    : picked ? (picked.label || picked.provider)
    : saved ? `My AI (${saved.label || saved.provider})` : 'School AI';

  const item = (label: React.ReactNode, selected: boolean, onClick: () => void, key: string) => (
    <button key={key} role="menuitemradio" aria-checked={selected} onClick={() => { onClick(); setOpen(false); }}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-surface-dark">
      <span className="w-3 shrink-0">{selected && <Check size={12} />}</span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );

  return (
    <span ref={ref} className={`relative inline-flex max-w-full ${className}`}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
          onDark ? 'text-white/60 hover:bg-white/10 hover:text-white' : 'text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark'
        }`}>
        <span className="shrink-0">Answers with:</span>
        <span className="min-w-0 truncate font-medium">{current}</span>
        <ChevronDown size={11} className="shrink-0" />
      </button>
      {open && (
        <span role="menu"
          className={`absolute left-0 z-50 w-64 ${menu === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border-light bg-white py-1 shadow-xl dark:border-border-dark/50 dark:bg-elevated-dark`}>
          {saved && item(<>My usual choice <span className="opacity-60">({saved.label || saved.provider})</span></>, value === null, () => onChange(null), 'saved')}
          {item('School AI', value === 'school' || (!saved && value === null), () => onChange('school'), 'school')}
          {routes.choices.map((c) => item(
            <>{c.label || c.provider} <span className="opacity-60">· {c.model}</span></>,
            value === choiceValue(c), () => onChange(choiceValue(c)), choiceValue(c),
          ))}
          <a href={myAiManageUrl()} target="_blank" rel="noopener noreferrer"
            className="mt-1 flex items-center gap-1.5 border-t border-border-light px-3 pb-1 pt-2 text-xs text-blue-600 hover:underline dark:border-border-dark/50 dark:text-blue-400">
            Manage My AI <ExternalLink size={11} />
          </a>
        </span>
      )}
    </span>
  );
};

const FALLBACK_WHY: Record<string, string> = {
  AI_KEY_NO_CREDIT: 'was out of credit',
  AI_KEY_INVALID: 'was not accepted by its provider',
  AI_KEY_RATE_LIMITED: 'hit its rate limit',
};

/** One line of text for "who answered", or null when there is nothing to say. */
export function answeredByText(ai: AiAnswer | null | undefined, providerUsed?: string | null): string | null {
  // "Paste the answer" (components/Handoff.tsx): the person's own Claude / ChatGPT answered.
  if (ai?.route === 'handoff') return 'via your own AI (pasted)';
  if (ai?.route === 'personal') {
    return `via ${[ai.label || ai.provider || 'My AI', ai.model].filter(Boolean).join(' · ')}`;
  }
  if (ai?.fallbackFrom) {
    const name = ai.label ? `'${ai.label}'` : '';
    return `Your key ${name} ${FALLBACK_WHY[ai.fallbackFrom] ?? 'could not answer'}, so School AI answered.`.replace(/\s+/g, ' ');
  }
  return providerUsed ? `via ${providerUsed}` : null;
}

/** "via My Claude · claude-sonnet-5-5", or the fallback note. Plain "via groq" for School AI. */
export const AiAnsweredBy: React.FC<{
  ai?: AiAnswer | null;
  providerUsed?: string | null;
  className?: string;
}> = ({ ai, providerUsed, className = '' }) => {
  const text = answeredByText(ai, providerUsed);
  if (!text) return null;
  return <span className={className} title={ai?.route === 'personal' ? 'Your own AI key answered (My AI)' : undefined}>{text}</span>;
};
