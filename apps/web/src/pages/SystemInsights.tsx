import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BellRing, CheckCircle2, Bug, ChevronDown } from 'lucide-react';
import { apiGet, apiPatch } from '../lib/api';
import { Button } from '../components/ui';
import { LoadError } from '../components/LoadError';

/**
 * The System page's monitoring (R-04, R-05): alert rules, the last hour of the
 * numbers every service writes, and grouped errors from browsers and servers.
 * Refreshed every minute while visible — samples are per minute anyway.
 */

type Series = Record<string, Array<[string, number]>>;
interface Alert { rule: string; firing: boolean; since: string | null; detail: string | null; updated_at: string }
interface ErrorRow {
  fingerprint: string; source: string; message: string; stack: string | null; route: string | null;
  release: string | null; count: number; first_at: string; last_at: string; last_user_agent: string | null;
  status: 'open' | 'resolved' | 'ignored';
}

/** The cards: which series, how to show its latest value, and when it is bad. */
const CARDS: Array<{ key: string; label: string; unit: string; bad?: (v: number) => boolean; digits?: number }> = [
  { key: 'api.http_requests', label: 'API requests / min', unit: '' },
  { key: 'api.http_5xx', label: 'API errors (5xx) / min', unit: '', bad: (v) => v > 0 },
  { key: 'api.http_p95_ms', label: 'API p95 latency', unit: ' ms', bad: (v) => v > 1500 },
  { key: 'realtime.sockets', label: 'Connected sockets', unit: '' },
  { key: 'worker.queue_waiting', label: 'Jobs waiting', unit: '', bad: (v) => v > 500 },
  { key: 'api.event_loop_p95_ms', label: 'API event-loop lag', unit: ' ms', bad: (v) => v > 250, digits: 1 },
  { key: 'system.host_free_mem_mb', label: 'Free memory', unit: ' MB', bad: (v) => v < 200 },
  { key: 'system.host_disk_free_pct', label: 'Free disk', unit: '%', bad: (v) => v < 10, digits: 1 },
];

const Sparkline: React.FC<{ points: Array<[string, number]>; bad: boolean }> = ({ points, bad }) => {
  if (points.length < 2) return <div className="h-8" />;
  const values = points.map(([, v]) => v);
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const d = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - min) / span) * 28 - 1}`).join(' ');
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={`h-8 w-full ${bad ? 'text-red-500' : 'text-blue-600 dark:text-blue-400'}`} aria-hidden="true">
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
};

const ago = (iso: string) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};

export const SystemInsights: React.FC = () => {
  const [series, setSeries] = useState<Series | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [errors, setErrors] = useState<ErrorRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, a, e] = await Promise.all([
        apiGet<{ series: Series }>('/api/system/metrics?minutes=60'),
        apiGet<{ alerts: Alert[] }>('/api/system/alerts'),
        apiGet<{ errors: ErrorRow[] }>('/api/system/errors?status=open'),
      ]);
      setSeries(m.data!.series); setAlerts(a.data!.alerts); setErrors(e.data!.errors); setFailed(false);
    } catch { setFailed(true); }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const settle = async (fp: string, status: 'resolved' | 'ignored') => {
    setErrors((prev) => prev?.filter((e) => e.fingerprint !== fp) ?? prev);
    try { await apiPatch(`/api/system/errors/${fp}`, { status }); } catch { void load(); }
  };

  if (failed && !series) return <LoadError what="monitoring" onRetry={() => void load()} />;
  const firing = alerts?.filter((a) => a.firing) ?? [];

  return (
    <div className="mt-8 space-y-8">
      <section aria-labelledby="sys-alerts">
        <h2 id="sys-alerts" className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <BellRing size={15} /> Alerts
        </h2>
        {alerts === null ? null : firing.length === 0 ? (
          <p className="flex items-center gap-2 rounded-xl border border-slate-200 p-3 text-sm text-slate-600 dark:border-border-dark dark:text-slate-300">
            <CheckCircle2 size={16} className="text-emerald-500" /> Nothing is firing.
            {alerts.length > 0 && <span className="text-xs text-slate-400">{alerts.length} rules checked every minute.</span>}
          </p>
        ) : (
          <ul className="space-y-2" aria-live="polite">
            {firing.map((a) => (
              <li key={a.rule} data-alert={a.rule} className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900/50 dark:bg-red-900/15">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" />
                <div className="min-w-0">
                  <p className="text-slate-900 dark:text-slate-100">{a.detail ?? a.rule}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{a.rule}{a.since ? ` · since ${ago(a.since)}` : ''}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="sys-trends">
        <h2 id="sys-trends" className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">Last hour</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {CARDS.map((c) => {
            const pts = series?.[c.key] ?? [];
            const latest = pts.length ? pts[pts.length - 1]![1] : null;
            const bad = latest !== null && Boolean(c.bad?.(latest));
            return (
              <div key={c.key} data-metric={c.key} className="rounded-xl border border-slate-200 p-3 dark:border-border-dark">
                <p className="text-xs text-slate-500 dark:text-slate-400">{c.label}</p>
                <p className={`mt-0.5 text-lg font-semibold tabular-nums ${bad ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'}`}>
                  {latest === null ? '—' : `${latest.toFixed(c.digits ?? 0)}${c.unit}`}
                </p>
                <Sparkline points={pts} bad={bad} />
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="sys-errors">
        <h2 id="sys-errors" className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <Bug size={15} /> Errors {errors && errors.length > 0 && <span className="text-xs font-normal text-slate-400">{errors.length} open</span>}
        </h2>
        {errors === null ? null : errors.length === 0 ? (
          <p className="rounded-xl border border-slate-200 p-3 text-sm text-slate-600 dark:border-border-dark dark:text-slate-300">No open errors.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-border-dark dark:border-border-dark">
            {errors.map((e) => (
              <li key={e.fingerprint} data-error={e.fingerprint} className="p-3">
                <button
                  className="flex w-full items-start gap-3 text-left"
                  aria-expanded={open === e.fingerprint}
                  onClick={() => setOpen((o) => (o === e.fingerprint ? null : e.fingerprint))}
                >
                  <span className="mt-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-600 dark:bg-elevated-dark dark:text-slate-300">{e.source}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-900 dark:text-slate-100">{e.message}</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {e.count}× · last {ago(e.last_at)}{e.route ? ` · ${e.route}` : ''}{e.release ? ` · ${e.release}` : ''}
                    </span>
                  </span>
                  <ChevronDown size={15} className={`mt-1 shrink-0 text-slate-400 transition-transform ${open === e.fingerprint ? 'rotate-180' : ''}`} />
                </button>
                {open === e.fingerprint && (
                  <div className="mt-3 space-y-3">
                    {e.stack && <pre className="max-h-56 overflow-auto rounded-lg bg-slate-50 p-2 text-[11px] text-slate-700 dark:bg-elevated-dark dark:text-slate-300">{e.stack}</pre>}
                    {e.last_user_agent && <p className="text-xs text-slate-500">{e.last_user_agent}</p>}
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => void settle(e.fingerprint, 'resolved')}>Mark resolved</Button>
                      <Button size="sm" variant="ghost" onClick={() => void settle(e.fingerprint, 'ignored')}>Ignore</Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
