import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';

interface ServiceHealth {
  key: string;
  label: string;
  url: string;
  state: 'checking' | 'healthy' | 'down';
  detail?: Record<string, string>;
  raw?: string;
}

/**
 * Live check of every backend service. This is the Phase 0 acceptance surface:
 * one page that proves the whole stack is wired together, and the first place
 * to look when something stops working in development.
 */
const SERVICES: Omit<ServiceHealth, 'state'>[] = [
  { key: 'api', label: 'API', url: '/svc/api/health' },
  { key: 'realtime', label: 'Realtime', url: '/svc/realtime/health' },
  { key: 'files', label: 'Files', url: '/svc/files/health' },
  { key: 'worker', label: 'Worker', url: '/svc/worker/health' },
];

export const SystemStatus: React.FC = () => {
  const [services, setServices] = useState<ServiceHealth[]>(
    SERVICES.map((s) => ({ ...s, state: 'checking' as const }))
  );

  useEffect(() => {
    SERVICES.forEach(async (service, index) => {
      try {
        const res = await fetch(service.url);
        const body = await res.json();
        setServices((prev) => prev.map((s, i) => i === index
          ? { ...s, state: res.ok ? 'healthy' : 'down', detail: body.checks, raw: body.status }
          : s));
      } catch {
        setServices((prev) => prev.map((s, i) => i === index ? { ...s, state: 'down' } : s));
      }
    });
  }, []);

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50">System status</h1>
      <p className="mt-1 mb-6 text-sm text-slate-500 dark:text-slate-400">
        Live health of each Tupo service.
      </p>

      <ul className="space-y-3">
        {services.map((s) => (
          <li key={s.key} className="flex items-start gap-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <span className="mt-0.5">
              {s.state === 'checking' && <Loader2 size={18} className="animate-spin text-slate-400" />}
              {s.state === 'healthy' && <CheckCircle2 size={18} className="text-emerald-500" />}
              {s.state === 'down' && <XCircle size={18} className="text-red-500" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{s.label}</span>
                <span className="text-xs text-slate-400">{s.raw ?? s.state}</span>
              </div>
              {s.detail && (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                  {Object.entries(s.detail).map(([k, v]) => (
                    <React.Fragment key={k}>
                      <dt className="font-mono">{k}</dt>
                      <dd className="truncate">{String(v)}</dd>
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
