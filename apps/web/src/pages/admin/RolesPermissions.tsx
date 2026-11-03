import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldCheck, Plus, Save, Trash2, Lock, Users as UsersIcon, Search, Undo2, RefreshCw } from 'lucide-react';
import { apiGet, apiPost, apiPut, apiDelete, ApiError } from '../../lib/api';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../context/AuthContext';
import { useNotify } from '../../context/NotificationContext';
import { Button, Card, Badge, PageHeader, Spinner } from '../../components/ui';
import { LoadError } from '../../components/LoadError';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';

/**
 * Roles and what they allow (F-12).
 *
 * Edits are drafts kept per role: moving to another role to compare keeps
 * them (each unsaved role is marked), and leaving the screen asks first.
 * Every save is made against the version that was on screen, so a colleague's
 * save in between is reported instead of silently overwritten. Name and
 * description are editable (a system role keeps its name), and the
 * permission list can be searched.
 */

interface PermissionDefinition { key: string; category: string; description: string }
interface Role {
  id: number; name: string; level: string; description: string | null; version: string;
  isSystem: boolean; permissionKeys: string[]; userCount: number;
}
interface Catalog { categoryOrder: string[]; grouped: Record<string, PermissionDefinition[]> }
interface Draft { keys: Set<string>; name: string; description: string }

const LEVELS = ['STUDENT', 'PARENT', 'STAFF', 'ADMIN'];
const LEVEL_TONE: Record<string, 'blue' | 'slate' | 'green' | 'amber'> = {
  STUDENT: 'blue', PARENT: 'green', STAFF: 'amber', ADMIN: 'slate',
};
const GOVERNANCE = ['ROLES_PERMISSIONS_MANAGE', 'USERS_MANAGE'];

const draftOf = (r: Role): Draft => ({ keys: new Set(r.permissionKeys), name: r.name, description: r.description ?? '' });

function changesOf(role: Role, d: Draft | undefined) {
  if (!d) return { added: [] as string[], removed: [] as string[], renamed: false, described: false, any: false };
  const before = new Set(role.permissionKeys);
  const added = [...d.keys].filter((k) => !before.has(k)).sort();
  const removed = role.permissionKeys.filter((k) => !d.keys.has(k)).sort();
  const renamed = d.name.trim() !== role.name;
  const described = d.description.trim() !== (role.description ?? '');
  return { added, removed, renamed, described, any: added.length + removed.length > 0 || renamed || described };
}

const inputClass = 'rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-border-dark dark:bg-chrome-dark dark:text-slate-100';

export const RolesPermissions: React.FC = () => {
  const { can } = usePermissions();
  const { refreshPermissions } = useAuth();
  const { confirm: confirmed } = useNotify();
  const canManage = can('ROLES_PERMISSIONS_MANAGE');
  const [confirm, dialog] = useConfirmDialog();
  const [params, setParams] = useSearchParams();

  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [drafts, setDrafts] = useState<Map<number, Draft>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);
  const [newRole, setNewRole] = useState({ name: '', level: 'STAFF', description: '' });
  const [filter, setFilter] = useState('');
  const [grantedOnly, setGrantedOnly] = useState(false);

  const selectedId = Number(params.get('role')) || roles[0]?.id || null;
  const selected = useMemo(() => roles.find((r) => r.id === selectedId) ?? null, [roles, selectedId]);
  const draft = selected ? drafts.get(selected.id) ?? draftOf(selected) : null;
  const pending = selected ? changesOf(selected, drafts.get(selected.id)) : null;
  const unsaved = useMemo(() => roles.filter((r) => changesOf(r, drafts.get(r.id)).any), [roles, drafts]);

  const select = (id: number) => setParams((cur) => { const n = new URLSearchParams(cur); n.set('role', String(id)); return n; }, { replace: true });

  const load = useCallback(async () => {
    try {
      const [rolesRes, catRes] = await Promise.all([
        apiGet<Role[]>('/api/roles-permissions/roles'),
        apiGet<Catalog>('/api/roles-permissions/permissions'),
      ]);
      setRoles(rolesRes.data ?? []);
      setCatalog(catRes.data ?? null);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useLeaveGuard(unsaved.length > 0 && canManage, () => confirm({
    title: 'Leave without saving?',
    body: <p>Unsaved changes to {unsaved.map((r) => r.name).join(', ')} will be lost.</p>,
    confirmLabel: 'Leave', cancelLabel: 'Keep editing', tone: 'danger',
  }));

  const edit = (patch: (d: Draft) => Draft) => {
    if (!selected || !canManage) return;
    setDrafts((cur) => {
      const next = new Map(cur);
      const updated = patch(cur.get(selected.id) ?? draftOf(selected));
      if (changesOf(selected, updated).any) next.set(selected.id, updated); else next.delete(selected.id);
      return next;
    });
  };
  const toggle = (key: string) => edit((d) => {
    const keys = new Set(d.keys);
    if (keys.has(key)) keys.delete(key); else keys.add(key);
    return { ...d, keys };
  });
  const toggleKeys = (keys: string[]) => edit((d) => {
    const allOn = keys.every((k) => d.keys.has(k));
    const next = new Set(d.keys);
    keys.forEach((k) => (allOn ? next.delete(k) : next.add(k)));
    return { ...d, keys: next };
  });
  const discard = (id: number) => setDrafts((cur) => { const n = new Map(cur); n.delete(id); return n; });

  const save = async (force = false) => {
    if (!selected || !draft || !pending?.any) return;
    if (!force && pending.removed.some((k) => GOVERNANCE.includes(k))) {
      const ok = await confirm({
        title: `Remove role management from ${selected.name}?`,
        body: <p>{selected.userCount} {selected.userCount === 1 ? 'person' : 'people'} with this role will no longer be able to {pending.removed.filter((k) => GOVERNANCE.includes(k)).map((k) => (k === 'USERS_MANAGE' ? 'manage users' : 'manage roles')).join(' or ')}.</p>,
        confirmLabel: 'Save', tone: 'danger',
      });
      if (!ok) return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { permissionKeys: [...draft.keys], expectedVersion: (force && conflict) ? conflict.version : selected.version };
      if (pending.renamed) body.name = draft.name.trim();
      if (pending.described) body.description = draft.description.trim();
      const res = await apiPut<Role>(`/api/roles-permissions/roles/${selected.id}`, body);
      setConflict(null);
      discard(selected.id);
      if (res.data) setRoles((cur) => cur.map((r) => (r.id === selected.id ? res.data! : r)));
      confirmed(`${draft.name.trim() || selected.name} saved`, {
        body: [pending.added.length && `${pending.added.length} added`, pending.removed.length && `${pending.removed.length} removed`].filter(Boolean).join(', ') || undefined,
      });
      // The caller may have just changed their own role's permissions.
      await refreshPermissions();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ROLE_STALE') {
        setConflict(((err.body as { data?: Role }).data) ?? null);
      } else {
        setError(err instanceof Error ? err.message : 'Could not save.');
      }
    } finally {
      setSaving(false);
    }
  };

  /** Their version wins: drop the draft and show what is saved now. */
  const takeTheirs = () => {
    if (!selected || !conflict) return;
    setRoles((cur) => cur.map((r) => (r.id === selected.id ? conflict : r)));
    discard(selected.id);
    setConflict(null);
  };

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiPost<Role>('/api/roles-permissions/roles', { ...newRole, permissionKeys: [] });
      setCreating(false);
      setNewRole({ name: '', level: 'STAFF', description: '' });
      await load();
      if (res.data) select(res.data.id);
      confirmed(`Role ${newRole.name.trim()} created`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the role.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (role: Role) => {
    const ok = await confirm({
      title: `Delete the role “${role.name}”?`,
      body: <p>This cannot be undone. Nobody holds it at the moment.</p>,
      confirmLabel: 'Delete role', tone: 'danger',
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/roles-permissions/roles/${role.id}`);
      discard(role.id);
      setParams(new URLSearchParams(), { replace: true });
      await load();
      confirmed(`Role ${role.name} deleted`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the role.');
    }
  };

  const needle = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!catalog || !draft) return [] as Array<[string, PermissionDefinition[]]>;
    return catalog.categoryOrder.map((category) => [
      category,
      (catalog.grouped[category] ?? []).filter((p) =>
        (!needle || p.key.toLowerCase().includes(needle) || p.description.toLowerCase().includes(needle) || category.toLowerCase().includes(needle))
        && (!grantedOnly || draft.keys.has(p.key))),
    ] as [string, PermissionDefinition[]]).filter(([, perms]) => perms.length > 0);
  }, [catalog, draft, needle, grantedOnly]);

  if (loading) return <div className="grid h-full place-items-center"><Spinner /></div>;
  if (loadFailed && roles.length === 0) {
    return <div className="px-4 pt-6 sm:px-6"><Card><LoadError what="roles" onRetry={() => void load()} /></Card></div>;
  }

  return (
    <div className="px-4 pb-24 pt-5 sm:px-6 sm:pt-6">
      <PageHeader
        title="Roles & permissions"
        subtitle="A role carries a permission set; every user holds one role. Changes take effect at once — open sessions update without a re-login."
        actions={canManage ? (
          <Button onClick={() => setCreating(true)}><Plus size={15} /> New role</Button>
        ) : undefined}
      />

      {error && (
        <div role="alert" className="mb-4 rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</div>
      )}

      {creating && (
        <Card className="mb-4 p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_2fr_auto]">
            <input autoFocus placeholder="Role name" aria-label="New role name" value={newRole.name} maxLength={60}
              onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} className={inputClass} />
            <select value={newRole.level} aria-label="New role level"
              onChange={(e) => setNewRole({ ...newRole, level: e.target.value })} className={inputClass}>
              {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <input placeholder="Description (optional)" aria-label="New role description" value={newRole.description} maxLength={300}
              onChange={(e) => setNewRole({ ...newRole, description: e.target.value })} className={inputClass} />
            <div className="flex gap-2">
              <Button onClick={create} disabled={!newRole.name.trim() || saving}>Create</Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            The level is fixed once the role is created — it drives navigation and default routing.
          </p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="h-fit overflow-hidden">
          <ul className="divide-y divide-slate-100 dark:divide-border-dark">
            {roles.map((role) => {
              const isUnsaved = unsaved.some((r) => r.id === role.id);
              return (
                <li key={role.id}>
                  <button
                    onClick={() => select(role.id)}
                    aria-current={role.id === selectedId ? 'true' : undefined}
                    className={`flex w-full items-start gap-2 px-4 py-3 text-left transition-colors ${
                      role.id === selectedId ? 'bg-blue-50 dark:bg-card-dark' : 'hover:bg-slate-50 dark:hover:bg-card-dark/50'}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{role.name}</span>
                        {role.isSystem && <Lock size={11} className="shrink-0 text-slate-400" aria-label="System role" />}
                        {isUnsaved && <span className="ml-auto shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">Unsaved</span>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone={LEVEL_TONE[role.level] ?? 'slate'}>{role.level}</Badge>
                        <span className="text-xs text-slate-400">{role.permissionKeys.length} perms</span>
                        <span className="flex items-center gap-0.5 text-xs text-slate-400">
                          <UsersIcon size={10} />{role.userCount}
                        </span>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        {selected && catalog && draft && pending && (
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-border-dark">
              <div className="min-w-0 flex-1 basis-64">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={16} className="shrink-0 text-blue-600 dark:text-blue-400" />
                  {canManage && !selected.isSystem ? (
                    <input value={draft.name} maxLength={60} aria-label="Role name"
                      onChange={(e) => edit((d) => ({ ...d, name: e.target.value }))}
                      className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-semibold text-slate-900 hover:border-slate-300 focus:border-blue-500 focus:outline-none dark:text-slate-100 dark:hover:border-border-dark" />
                  ) : (
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{selected.name}</h2>
                  )}
                  {selected.isSystem && <Badge tone="slate">System role</Badge>}
                </div>
                {canManage ? (
                  <input value={draft.description} maxLength={300} aria-label="Role description" placeholder="Add a description"
                    onChange={(e) => edit((d) => ({ ...d, description: e.target.value }))}
                    className="mt-1 w-full max-w-xl rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-xs text-slate-500 hover:border-slate-300 focus:border-blue-500 focus:outline-none dark:text-slate-400 dark:hover:border-border-dark" />
                ) : selected.description && (
                  <p className="mt-1 max-w-xl text-xs text-slate-500 dark:text-slate-400">{selected.description}</p>
                )}
                {selected.isSystem && canManage && (
                  <p className="mt-1 px-1.5 text-[11px] text-slate-400">A system role keeps its name — sign-in maps people to it.</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {canManage && !selected.isSystem && (
                  <Button variant="ghost" size="sm" onClick={() => void remove(selected)}
                    disabled={selected.userCount > 0}
                    title={selected.userCount > 0 ? `${selected.userCount} people hold this role — reassign them first` : undefined}>
                    <Trash2 size={14} /> Delete
                  </Button>
                )}
                {canManage && pending.any && (
                  <Button variant="ghost" size="sm" onClick={() => discard(selected.id)}><Undo2 size={14} /> Discard</Button>
                )}
                {canManage && (
                  <Button size="sm" onClick={() => void save()} disabled={!pending.any || saving || !draft.name.trim()}>
                    <Save size={14} /> {saving ? 'Saving…' : pending.any ? `Save (${draft.keys.size})` : 'Saved'}
                  </Button>
                )}
              </div>
            </div>

            {conflict && (
              <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">
                <span className="min-w-0 flex-1">
                  Someone else saved changes to {conflict.name} while you were editing
                  ({conflict.permissionKeys.length} permissions now). Yours are not saved yet.
                </span>
                <Button variant="secondary" size="sm" onClick={takeTheirs}><RefreshCw size={13} /> Load their version</Button>
                <Button variant="danger" size="sm" onClick={() => void save(true)}>Save mine over it</Button>
              </div>
            )}

            {pending.any && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 bg-slate-50/60 px-5 py-2 text-xs dark:border-border-dark dark:bg-chrome-dark/40">
                <span className="font-medium text-slate-600 dark:text-slate-300">Unsaved:</span>
                {pending.renamed && <Badge tone="blue">renamed</Badge>}
                {pending.described && <Badge tone="blue">description</Badge>}
                {pending.added.map((k) => <span key={k} className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200">+{k}</span>)}
                {pending.removed.map((k) => <span key={k} className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-red-800 dark:bg-red-500/15 dark:text-red-200">−{k}</span>)}
              </div>
            )}

            {!canManage && (
              <p className="border-b border-slate-100 bg-slate-50 px-5 py-2 text-xs text-slate-500 dark:border-border-dark dark:bg-chrome-dark/50 dark:text-slate-400">
                You have read-only access to roles. ROLES_PERMISSIONS_MANAGE is required to edit them.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3 dark:border-border-dark">
              <div className="relative min-w-0 flex-1 basis-56 sm:max-w-xs">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search permissions"
                  aria-label="Search permissions" className={`${inputClass} w-full py-1.5 pl-8`} />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={grantedOnly} onChange={(e) => setGrantedOnly(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600" />
                Only granted
              </label>
              <span className="ml-auto text-xs tabular-nums text-slate-400">{draft.keys.size} granted</span>
            </div>

            <div className="divide-y divide-slate-100 dark:divide-border-dark">
              {visible.length === 0 && (
                <p className="px-5 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                  No permissions match{needle ? ` “${filter.trim()}”` : ''}.
                </p>
              )}
              {visible.map(([category, perms]) => {
                const all = catalog.grouped[category] ?? [];
                const onCount = all.filter((p) => draft.keys.has(p.key)).length;
                const shownKeys = perms.map((p) => p.key);
                const shownAllOn = shownKeys.every((k) => draft.keys.has(k));
                return (
                  <section key={category} className="px-5 py-4" aria-label={category}>
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{category}</h3>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-400">{onCount}/{all.length}</span>
                        {canManage && (
                          <button onClick={() => toggleKeys(shownKeys)}
                            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">
                            {shownAllOn ? 'Clear all' : 'Select all'}{needle || grantedOnly ? ' shown' : ''}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {perms.map((p) => {
                        const changed = pending.added.includes(p.key) || pending.removed.includes(p.key);
                        return (
                          <label key={p.key} title={p.description}
                            className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm ${
                              canManage ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-card-dark/50' : 'cursor-default'} ${
                              changed ? 'ring-1 ring-amber-300 dark:ring-amber-500/40' : ''}`}>
                            <input type="checkbox" checked={draft.keys.has(p.key)} disabled={!canManage}
                              onChange={() => toggle(p.key)}
                              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-border-dark" />
                            <span className="min-w-0">
                              <span className="block font-mono text-xs text-slate-700 dark:text-slate-200">{p.key}</span>
                              <span className="block text-xs leading-snug text-slate-400">{p.description}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </Card>
        )}
      </div>
      {dialog}
    </div>
  );
};
