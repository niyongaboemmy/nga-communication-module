import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowDown, ArrowUp, Ban, CheckCircle2, ChevronLeft, ChevronRight, Download, RefreshCw, Search, UserCog,
} from 'lucide-react';
import { apiGet, apiPut, ApiError, SESSION_KEY } from '../../lib/api';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../context/AuthContext';
import { useNotify } from '../../context/NotificationContext';
import { Avatar, Button, Card, Badge, PageHeader, Spinner, EmptyState } from '../../components/ui';
import { LoadError } from '../../components/LoadError';
import { useConfirmDialog } from '../../components/ConfirmDialog';

/**
 * The roster (F-11). Paged with a real total, filtered and sorted on the
 * server, with the filters in the address so a view can be shared or
 * reloaded. A role change says what it changes and asks first; the role
 * dropdown only appears once the roles it offers have actually loaded.
 */

interface RosterUser {
  id: string; mis_user_id: string; name: string; email: string; avatar_url: string | null; role: string; status: string;
  role_id: number | null; role_name: string | null; role_level: string | null;
  role_assigned_by_admin: boolean; last_login_at: string | null;
}
interface AssignableRole {
  id: number; name: string; level: string; members: number; permissionCount: number;
  assignable: boolean; grantsGovernance: boolean;
}
interface Facets { all: number; active: number; suspended: number; unassigned: number }
type RosterPage = { data?: RosterUser[]; total?: number; facets?: Facets };

const PAGE_SIZE = 50;
const SORT_LABEL: Record<string, string> = { name: 'Name', last_login: 'Last sign-in', role: 'Role', status: 'Status' };
const LEVEL_RANK: Record<string, number> = { STUDENT: 0, PARENT: 1, STAFF: 2, ADMIN: 3 };

export const Users: React.FC = () => {
  const { can } = usePermissions();
  const { user: me } = useAuth();
  const { confirm: confirmed, notify } = useNotify();
  const canManage = can('USERS_MANAGE');
  const [confirm, dialog] = useConfirmDialog();

  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const role = params.get('role') ?? '';
  const status = params.get('status') ?? '';
  const sort = SORT_LABEL[params.get('sort') ?? ''] ? params.get('sort')! : 'name';
  const dir = params.get('dir') === 'desc' ? 'desc' : 'asc';
  const page = Math.max(Number(params.get('page')) || 1, 1);

  const setFilter = useCallback((patch: Record<string, string | null>) => {
    setParams((cur) => {
      const next = new URLSearchParams(cur);
      for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
      // Any change but paging goes back to the first page.
      if (!('page' in patch)) next.delete('page');
      return next;
    }, { replace: true });
  }, [setParams]);

  const [draft, setDraft] = useState(q);
  useEffect(() => { setDraft(q); }, [q]);
  // Search as you type, without a request per keystroke.
  useEffect(() => {
    if (draft === q) return;
    const t = setTimeout(() => setFilter({ q: draft.trim() || null }), 350);
    return () => clearTimeout(t);
  }, [draft, q, setFilter]);

  const [users, setUsers] = useState<RosterUser[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [roles, setRoles] = useState<AssignableRole[] | null>(null);
  const [rolesFailed, setRolesFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const generation = useRef(0);

  const query = useMemo(() => {
    const s = new URLSearchParams({ sort, dir, limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
    if (q) s.set('q', q);
    if (role) s.set('role', role);
    if (status) s.set('status', status);
    return s.toString();
  }, [q, role, status, sort, dir, page]);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    try {
      const res = await apiGet<RosterUser[]>(`/api/users?${query}`) as RosterPage;
      if (gen !== generation.current) return;
      setUsers(res.data ?? []);
      setTotal(res.total ?? 0);
      setFacets(res.facets ?? null);
      setLoadFailed(false);
    } catch {
      if (gen === generation.current) setLoadFailed(true);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [query]);
  useEffect(() => { void load(); }, [load]);

  const loadRoles = useCallback(async () => {
    if (!canManage) return;
    setRolesFailed(false);
    try {
      const r = await apiGet<AssignableRole[]>('/api/users/assignable-roles');
      setRoles(r.data ?? []);
    } catch {
      setRoles(null);
      setRolesFailed(true);
    }
  }, [canManage]);
  useEffect(() => { void loadRoles(); }, [loadRoles]);

  const roleById = useMemo(() => new Map((roles ?? []).map((r) => [r.id, r])), [roles]);

  const assignRole = async (u: RosterUser, roleId: number | null) => {
    if (roleId === u.role_id) return;
    setError(null);
    const to = roleId === null ? null : roleById.get(roleId) ?? null;
    const fromName = u.role_name ?? 'Unassigned';
    const toName = to?.name ?? 'Unassigned';
    const promotion = to && (LEVEL_RANK[to.level] ?? 0) > (LEVEL_RANK[u.role_level ?? ''] ?? -1);
    const self = u.id === me?.id;
    const ok = await confirm({
      title: `Change ${u.name}'s role?`,
      body: <p><span className="font-medium">{fromName}</span> → <span className="font-medium">{toName}</span>. It applies straight away, on every device they use, and an MIS sign-in will not change it back.</p>,
      warning: !to
        ? 'With no role they lose access to Tupo until someone gives them one.'
        : to.grantsGovernance
          ? `${to.name} can manage users and roles${self ? '' : ' — including yours'}. Only give it to someone who should run Tupo.`
          : self
            ? 'This is your own role. You may lose access to this screen.'
            : promotion
              ? `${to.name} grants ${to.permissionCount} permissions — more than ${fromName}.`
              : undefined,
      confirmLabel: 'Change role',
      tone: to?.grantsGovernance || !to || self ? 'danger' : 'default',
    });
    if (!ok) return;
    setBusyId(u.id);
    try {
      await apiPut(`/api/users/${u.id}/role`, { roleId, expectedRoleId: u.role_id });
      confirmed(`${u.name} is now ${toName}`);
      await Promise.all([load(), loadRoles()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not assign the role.');
      if (err instanceof ApiError && err.status === 409) void load();
    } finally {
      setBusyId(null);
    }
  };

  const toggleStatus = async (u: RosterUser) => {
    const next = u.status === 'active' ? 'suspended' : 'active';
    const ok = await confirm(next === 'suspended'
      ? {
        title: `Suspend ${u.name}?`,
        body: <p>They are signed out of Tupo on every device at once and cannot sign back in until reactivated. Their messages stay.</p>,
        confirmLabel: 'Suspend', tone: 'danger',
      }
      : { title: `Reactivate ${u.name}?`, body: <p>They can sign in again with their current role.</p>, confirmLabel: 'Reactivate' });
    if (!ok) return;
    setBusyId(u.id);
    try {
      await apiPut(`/api/users/${u.id}/status`, { status: next });
      confirmed(next === 'suspended' ? `${u.name} is suspended` : `${u.name} is active again`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the account.');
    } finally {
      setBusyId(null);
    }
  };

  const exportCsv = async () => {
    try {
      const s = new URLSearchParams(query);
      s.delete('limit'); s.delete('offset');
      const res = await fetch(`/api/users/export.csv?${s}`, { headers: { Authorization: `Bearer ${localStorage.getItem(SESSION_KEY)}` } });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'tupo-users.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      notify({ title: 'The export failed', body: 'Try again in a moment.', tone: 'error' });
    }
  };

  const sortBy = (key: string) => {
    setFilter({ sort: key, dir: sort === key && dir === 'asc' ? 'desc' : 'asc' });
  };
  const SortHeader: React.FC<{ k: string; children: React.ReactNode }> = ({ k, children }) => (
    <th className="px-4 py-3 font-medium" aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button onClick={() => sortBy(k)} className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-700 dark:hover:text-slate-200">
        {children}
        {sort === k && (dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  );

  const filtered = Boolean(q || role || status);
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const chip = (value: string, label: string, count?: number) => (
    <button
      key={value || 'all'}
      onClick={() => setFilter({ status: value || null })}
      aria-pressed={status === value}
      className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
        status === value
          ? 'bg-blue-600 text-white'
          : 'border border-border-light text-text-secondary-light hover:bg-surface-light dark:border-border-dark/50 dark:text-text-secondary-dark dark:hover:bg-surface-dark'}`}
    >
      {label}{count !== undefined && <span className="ml-1 tabular-nums opacity-80">{count}</span>}
    </button>
  );

  return (
    <div className="px-4 pb-24 pt-5 sm:px-6 sm:pt-6">
      <PageHeader
        title="Users"
        subtitle="Everyone who has signed in through the NGA Central MIS. Accounts appear here on first sign-in — they are never created in Tupo."
        actions={<Button variant="secondary" size="sm" onClick={() => void exportCsv()}><Download size={14} /> Export CSV</Button>}
      />

      {error && (
        <div role="alert" className="mb-4 rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-60 sm:max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setFilter({ q: draft.trim() || null }); }}
            placeholder="Search by name or email"
            aria-label="Search users by name or email"
            className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm dark:border-border-dark dark:bg-elevated-dark dark:text-slate-100"
          />
        </div>
        <Button variant="secondary" onClick={() => setFilter({ q: draft.trim() || null })}>Search</Button>
        <select
          value={role}
          onChange={(e) => setFilter({ role: e.target.value || null })}
          aria-label="Filter by role"
          className="rounded-lg border border-slate-300 px-2 py-2 text-sm dark:border-border-dark dark:bg-elevated-dark dark:text-slate-100"
        >
          <option value="">All roles</option>
          <option value="none">Unassigned{facets ? ` (${facets.unassigned})` : ''}</option>
          {(roles ?? []).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.members})</option>)}
        </select>
        <select
          value={`${sort}:${dir}`}
          onChange={(e) => { const [k, d] = e.target.value.split(':'); setFilter({ sort: k!, dir: d! }); }}
          aria-label="Sort users"
          className="rounded-lg border border-slate-300 px-2 py-2 text-sm dark:border-border-dark dark:bg-elevated-dark dark:text-slate-100"
        >
          <option value="name:asc">Name A–Z</option>
          <option value="name:desc">Name Z–A</option>
          <option value="last_login:desc">Signed in most recently</option>
          <option value="last_login:asc">Signed in longest ago</option>
          <option value="role:asc">Role</option>
          <option value="status:asc">Status</option>
        </select>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by status">
        {chip('', 'Everyone', facets?.all)}
        {chip('active', 'Active', facets?.active)}
        {chip('suspended', 'Suspended', facets?.suspended)}
        {filtered && (
          <button onClick={() => { setDraft(''); setParams(new URLSearchParams(), { replace: true }); }}
            className="ml-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">
            Clear filters
          </button>
        )}
      </div>

      {canManage && rolesFailed && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          The list of roles did not load, so roles cannot be changed right now.
          <button onClick={() => void loadRoles()} className="inline-flex items-center gap-1 font-medium underline">
            <RefreshCw size={13} /> Try again
          </button>
        </div>
      )}

      <Card className="overflow-hidden">
        {loading && users.length === 0 ? (
          <div className="grid place-items-center py-16"><Spinner /></div>
        ) : loadFailed && users.length === 0 ? (
          <LoadError what="users" onRetry={() => void load()} />
        ) : users.length === 0 && filtered ? (
          <EmptyState
            title={q ? `No one matches “${q}”` : 'No one matches these filters'}
            hint={q ? 'Try part of a name or an email address, or clear the filters.' : 'Clear the filters to see everyone.'}
          />
        ) : users.length === 0 ? (
          <EmptyState title="No users yet" hint="Users appear here the first time they sign in through the MIS." />
        ) : (
          <div className={`overflow-x-auto transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
            <table className="table-stack w-full text-sm">
              <caption className="sr-only">Users, sorted by {SORT_LABEL[sort]} {dir === 'asc' ? 'ascending' : 'descending'}</caption>
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-border-dark dark:bg-chrome-dark/50 dark:text-slate-400">
                <tr>
                  <SortHeader k="name">User</SortHeader>
                  <SortHeader k="role">Role</SortHeader>
                  <SortHeader k="status">Status</SortHeader>
                  <SortHeader k="last_login">Last sign-in</SortHeader>
                  {canManage && <th className="px-4 py-3 font-medium"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-border-dark">
                {users.map((u) => {
                  const current = u.role_id !== null ? roleById.get(u.role_id) : undefined;
                  return (
                    <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-card-dark/40">
                      <td data-primary className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <Avatar name={u.name} src={u.avatar_url ?? undefined} size={36} tintKey={u.id} preview previewCaption={u.role_name ?? u.role} />
                          <div className="min-w-0">
                            <div className="font-medium text-slate-900 dark:text-slate-100">
                              {u.name}{u.id === me?.id && <span className="ml-1.5 text-xs font-normal text-slate-400">(you)</span>}
                            </div>
                            <div className="break-all text-xs text-slate-400 md:max-w-[16rem] md:truncate md:break-normal">{u.email || `MIS #${u.mis_user_id}`}</div>
                          </div>
                        </div>
                      </td>
                      <td data-label="Role" className="px-4 py-3">
                        <span className="inline-flex items-center">
                          {canManage && roles ? (
                            <select
                              value={u.role_id ?? ''}
                              disabled={busyId === u.id || (current ? !current.assignable : false)}
                              title={current && !current.assignable ? 'This person holds permissions you do not, so you cannot change their role.' : undefined}
                              onChange={(e) => void assignRole(u, e.target.value === '' ? null : Number(e.target.value))}
                              aria-label={`Role for ${u.name}`}
                              className="rounded-lg border border-slate-300 px-2 py-1 text-xs disabled:opacity-60 dark:border-border-dark dark:bg-elevated-dark dark:text-slate-100"
                            >
                              <option value="">— Unassigned —</option>
                              {roles.map((r) => (
                                <option key={r.id} value={r.id} disabled={!r.assignable && r.id !== u.role_id}>
                                  {r.name}{!r.assignable ? ' (beyond your access)' : ''}
                                </option>
                              ))}
                              {/* Never let the person's real role vanish from the list. */}
                              {u.role_id !== null && !current && <option value={u.role_id}>{u.role_name ?? `Role #${u.role_id}`}</option>}
                            </select>
                          ) : u.role_name ? (
                            <Badge tone="blue">{u.role_name}</Badge>
                          ) : (
                            <Badge tone="amber">Unassigned</Badge>
                          )}
                          {busyId === u.id && <Spinner className="ml-2 h-3 w-3" />}
                          {u.role_assigned_by_admin && (
                            <span title="Set by an administrator; a MIS re-login will not change it"
                              aria-label="Set by an administrator"
                              className="ml-2 inline-flex align-middle text-slate-400"><UserCog size={12} /></span>
                          )}
                        </span>
                      </td>
                      <td data-label="Status" className="px-4 py-3">
                        <Badge tone={u.status === 'active' ? 'green' : 'red'}>{u.status}</Badge>
                      </td>
                      <td data-label="Last sign-in" className="px-4 py-3 text-xs text-slate-400 tabular-nums">
                        <span>{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never'}</span>
                      </td>
                      {canManage && (
                        <td data-actions className="px-4 py-3 text-right">
                          {u.id !== me?.id && (
                            <Button variant="ghost" size="sm" disabled={busyId === u.id} onClick={() => void toggleStatus(u)}>
                              {u.status === 'active'
                                ? <><Ban size={13} /> Suspend</>
                                : <><CheckCircle2 size={13} /> Reactivate</>}
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {total > 0 && (
          <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 text-xs text-slate-500 dark:border-border-dark dark:text-slate-400">
            <span className="tabular-nums">Showing {from}–{to} of {total}</span>
            <span className="flex items-center gap-1">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setFilter({ page: String(page - 1) })} aria-label="Previous page">
                <ChevronLeft size={14} /> Previous
              </Button>
              <span className="px-1 tabular-nums">Page {page} of {pages}</span>
              <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => setFilter({ page: String(page + 1) })} aria-label="Next page">
                Next <ChevronRight size={14} />
              </Button>
            </span>
          </nav>
        )}
      </Card>
      {dialog}
    </div>
  );
};
