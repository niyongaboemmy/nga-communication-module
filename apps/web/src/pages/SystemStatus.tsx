import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, XCircle, Loader2, AlertTriangle, RefreshCw, Clock } from 'lucide-react';
import { Button } from '../components/ui';

/**
 * Live check of every backend service — the first place to look when
 * something stops working.
 *
 * F-14: each check gives up after a few seconds instead of spinning forever
 * on a service that accepts the connection and never answers; a service that
 * answers "degraded" (up, but missing Redis or its database) is shown as
 * such rather than as down; and the page re-checks on its own every 30
 * seconds while it is on screen, with the time of the last check shown.
 */

type State = 'checking' | 'healthy' | 'degraded' | 'down' | 'timeout';

interface ServiceHealth {
  key: string;
  label: string;
  url: string;
  state: State;
  detail?: Record<string, string>;
  raw?: string;
  ms?: number;
}

const SERVICES: Array<Pick<ServiceHealth, 'key' | 'label' | 'url'>> = [
  { key: 'api', label: 'API', url: '/svc/api/health' },
  { key: 'realtime', label: 'Realtime', url: '/svc/realtime/health' },
  { key: 'files', label: 'Files', url: '/svc/files/health' },
  { key: 'worker', label: 'Worker', url: '/svc/worker/health' },
];

const TIMEOUT_MS = 5000;
const REFRESH_MS = 30_000;

const STATE_TEXT: Record<State, string> = {
  checking: 'checking…', healthy: 'healthy', degraded: 'degraded', down: 'down', timeout: 'not answering',
};

async function check(service: Pick<ServiceHealth, 'url'>): Promise<Omit<ServiceHealth, 'key' | 'label' | 'url'>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = performance.now();
  try {
    const res = await fetch(service.url, { signal: controller.signal, cache: 'no-store' });
    const ms = Math.round(performance.now() - started);
    let body: { status?: string; checks?: Record<string, string> } = {};
    try { body = await res.json(); } catch { /* a proxy error page */ }
    const state: State = res.ok ? 'healthy' : body.status === 'degraded' ? 'degraded' : 'down';
    return { state, detail: body.checks, raw: body.status, ms };
  } catch {
    return controller.signal.aborted ? { state: 'timeout', ms: TIMEOUT_MS } : { state: 'down' };
  } finally {
    clearTimeout(timer);
  }
}

export const SystemStatus: React.FC = () => {
  const [services, setServices] = useState<ServiceHealth[]>(
    SERVICES.map((s) => ({ ...s, state: 'checking' as const })),
  );
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [running, setRunning] = useState(false);
  const inFlight = useRef(false);

  const runAll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    await Promise.all(SERVICES.map(async (service, index) => {
      const result = await check(service);
      setServices((prev) => prev.map((s, i) => (i === index ? { ...s, ...result } : s)));
    }));
    setCheckedAt(new Date());
    setRunning(false);
    inFlight.current = false;
  }, []);

  useEffect(() => {
    void runAll();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) timer = setInterval(() => void runAll(), REFRESH_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => { if (document.hidden) stop(); else { void runAll(); start(); } };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [runAll]);

  const problems = services.filter((s) => s.state !== 'healthy' && s.state !== 'checking').length;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:p-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50">System status</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400" aria-live="polite">
            {running && !checkedAt ? 'Checking every service…'
              : problems ? `${problems} of ${services.length} services need attention.`
                : 'Every service is healthy.'}
          </p>
          {checkedAt && (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-slate-400">
              <Clock size={11} /> Checked {checkedAt.toLocaleTimeString()} · re-checks every 30 s while open
            </p>
          )}
        </div>
        <Button variant="secondary" size="sm" onClick={() => void runAll()} disabled={running}>
          <RefreshCw size={13} className={running ? 'animate-spin' : ''} /> Check now
        </Button>
      </div>

      <ul className="space-y-3">
        {services.map((s) => (
          <li key={s.key} data-service={s.key} data-state={s.state}
            className="flex items-start gap-3 rounded-xl border border-slate-200 p-4 dark:border-border-dark">
            <span className="mt-0.5">
              {s.state === 'checking' && <Loader2 size={18} className="animate-spin text-slate-400" />}
              {s.state === 'healthy' && <CheckCircle2 size={18} className="text-emerald-500" />}
              {(s.state === 'degraded' || s.state === 'timeout') && <AlertTriangle size={18} className="text-amber-500" />}
              {s.state === 'down' && <XCircle size={18} className="text-red-500" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{s.label}</span>
                <span className="text-xs text-slate-400">
                  {STATE_TEXT[s.state]}{s.ms !== undefined && s.state !== 'timeout' ? ` · ${s.ms} ms` : ''}
                </span>
              </div>
              {s.state === 'timeout' && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">No answer within {TIMEOUT_MS / 1000} s — the service may be overloaded or stuck.</p>
              )}
              {s.detail && (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                  {Object.entries(s.detail).map(([k, v]) => (
                    <React.Fragment key={k}>
                      <dt className="font-mono">{k}</dt>
                      <dd className={`truncate ${String(v) === 'ok' ? '' : 'text-amber-700 dark:text-amber-300'}`}>{String(v)}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};
