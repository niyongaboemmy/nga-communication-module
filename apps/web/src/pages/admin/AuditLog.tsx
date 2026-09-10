import React, { useEffect, useState } from 'react';
import { apiGet } from '../../lib/api';
import { Card, PageHeader, Spinner, EmptyState, Badge } from '../../components/ui';

interface AuditEntry {
  id: string; action: string; target_type: string | null; target_id: string | null;
  metadata: Record<string, unknown>; ip_address: string | null; created_at: string;
  actor_name: string | null; actor_email: string | null;
}

const TONE: Record<string, 'blue' | 'green' | 'amber' | 'red' | 'slate'> = {
  'auth.login': 'green',
  'role.create': 'blue', 'role.update': 'blue', 'role.delete': 'red',
  'user.role.assign': 'amber', 'user.suspended': 'red', 'user.active': 'green',
  'chat.oversight.conversation.read': 'amber',
  'chat.oversight.message.remove': 'red',
};

export const AuditLog: React.FC = () => {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet<AuditEntry[]>('/api/audit?limit=200')
      .then((r) => setEntries(r.data ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6">
      <PageHeader
        title="Audit log"
        subtitle="Append-only record of privileged actions. Nothing in Tupo updates or deletes these rows."
      />
      <Card className="overflow-hidden">
        {loading ? (
          <div className="grid place-items-center py-16"><Spinner /></div>
        ) : entries.length === 0 ? (
          <EmptyState title="No audit entries yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-border-dark dark:bg-chrome-dark/50 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-medium">When</th>
                  <th className="px-4 py-3 font-medium">Actor</th>
                  <th className="px-4 py-3 font-medium">Action</th>
                  <th className="px-4 py-3 font-medium">Target</th>
                  <th className="px-4 py-3 font-medium">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-border-dark">
                {entries.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50 dark:hover:bg-card-dark/40">
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-slate-500 tabular-nums dark:text-slate-400">
                      {new Date(e.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-slate-700 dark:text-slate-200">{e.actor_name ?? '—'}</td>
                    <td className="px-4 py-2.5"><Badge tone={TONE[e.action] ?? 'slate'}>{e.action}</Badge></td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-400">
                      {e.target_type ? `${e.target_type}:${e.target_id}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-400">{e.ip_address ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};
