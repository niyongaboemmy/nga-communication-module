import React, { useEffect, useState } from 'react';
import { Search, UserCog, Ban, CheckCircle2 } from 'lucide-react';
import { apiGet, apiPut } from '../../lib/api';
import { usePermissions } from '../../hooks/usePermissions';
import { Button, Card, Badge, PageHeader, Spinner, EmptyState } from '../../components/ui';

interface RosterUser {
  id: string; mis_user_id: string; name: string; email: string; role: string; status: string;
  role_id: number | null; role_name: string | null; role_level: string | null;
  role_assigned_by_admin: boolean; last_login_at: string | null;
}
interface Role { id: number; name: string; level: string }

export const Users: React.FC = () => {
  const { can } = usePermissions();
  const canManage = can('USERS_MANAGE');

  const [users, setUsers] = useState<RosterUser[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (q = '') => {
    setLoading(true);
    try {
      const res = await apiGet<RosterUser[]>(`/api/users?q=${encodeURIComponent(q)}`);
      setUsers(res.data ?? []);
      // Role list is only needed to populate the assignment dropdown, and
      // requires its own permission — a USERS_VIEW-only admin still sees the
      // roster, just without the ability to reassign.
      if (canManage) {
        const r = await apiGet<Role[]>('/api/roles-permissions/roles').catch(() => ({ data: [] }));
        setRoles(r.data ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load users.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const assignRole = async (user: RosterUser, roleId: number | null) => {
    setError(null);
    try {
      await apiPut(`/api/users/${user.id}/role`, { roleId });
      await load(query);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not assign the role.');
    }
  };

  const toggleStatus = async (user: RosterUser) => {
    const next = user.status === 'active' ? 'suspended' : 'active';
    if (next === 'suspended' && !confirm(`Suspend ${user.name}? They will be signed out of Tupo.`)) return;
    try {
      await apiPut(`/api/users/${user.id}/status`, { status: next });
      await load(query);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the account.');
    }
  };

  return (
    <div className="p-6">
      <PageHeader
        title="Users"
        subtitle="Everyone who has signed in through the NGA Central MIS. Accounts appear here on first sign-in — they are never created in Tupo."
      />

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="mb-4 flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(query)}
            placeholder="Search by name or email"
            className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm dark:border-border-dark dark:bg-elevated-dark dark:text-slate-100"
          />
        </div>
        <Button variant="secondary" onClick={() => load(query)}>Search</Button>
      </div>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="grid place-items-center py-16"><Spinner /></div>
        ) : users.length === 0 ? (
          <EmptyState title="No users yet" hint="Users appear here the first time they sign in through the MIS." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-border-dark dark:bg-chrome-dark/50 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-medium">User</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Last sign-in</th>
                  {canManage && <th className="px-4 py-3 font-medium" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-border-dark">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-card-dark/40">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900 dark:text-slate-100">{u.name}</div>
                      <div className="text-xs text-slate-400">{u.email || `MIS #${u.mis_user_id}`}</div>
                    </td>
                    <td className="px-4 py-3">
                      {canManage ? (
                        <select
                          value={u.role_id ?? ''}
                          onChange={(e) => assignRole(u, e.target.value === '' ? null : Number(e.target.value))}
                          className="rounded-lg border border-slate-300 px-2 py-1 text-xs dark:border-border-dark dark:bg-elevated-dark dark:text-slate-100"
                        >
                          <option value="">— Unassigned —</option>
                          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                      ) : u.role_name ? (
                        <Badge tone="blue">{u.role_name}</Badge>
                      ) : (
                        <Badge tone="amber">Unassigned</Badge>
                      )}
                      {u.role_assigned_by_admin && (
                        <span title="Set by an administrator; a MIS re-login will not change it"
                          className="ml-2 inline-flex align-middle text-slate-400"><UserCog size={12} /></span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={u.status === 'active' ? 'green' : 'red'}>{u.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400 tabular-nums">
                      {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'}
                    </td>
                    {canManage && (
                      <td className="px-4 py-3 text-right">
                        <Button variant="ghost" size="sm" onClick={() => toggleStatus(u)}>
                          {u.status === 'active'
                            ? <><Ban size={13} /> Suspend</>
                            : <><CheckCircle2 size={13} /> Reactivate</>}
                        </Button>
                      </td>
                    )}
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
