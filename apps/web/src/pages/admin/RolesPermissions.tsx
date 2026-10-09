import React, { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, Plus, Save, Trash2, Lock, Users as UsersIcon } from 'lucide-react';
import { apiGet, apiPost, apiPut, apiDelete } from '../../lib/api';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../context/AuthContext';
import { Button, Card, Badge, PageHeader, Spinner } from '../../components/ui';

interface PermissionDefinition { key: string; category: string; description: string }
interface Role {
  id: number; name: string; level: string; description: string | null;
  isSystem: boolean; permissionKeys: string[]; userCount: number;
}
interface Catalog { categoryOrder: string[]; grouped: Record<string, PermissionDefinition[]> }

const LEVELS = ['STUDENT', 'PARENT', 'STAFF', 'ADMIN'];
const LEVEL_TONE: Record<string, 'blue' | 'slate' | 'green' | 'amber'> = {
  STUDENT: 'blue', PARENT: 'green', STAFF: 'amber', ADMIN: 'slate',
};

export const RolesPermissions: React.FC = () => {
  const { can } = usePermissions();
  const { refreshPermissions } = useAuth();
  const canManage = can('ROLES_PERMISSIONS_MANAGE');

  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newRole, setNewRole] = useState({ name: '', level: 'STAFF', description: '' });

  const selected = useMemo(() => roles.find((r) => r.id === selectedId) ?? null, [roles, selectedId]);

  const load = async () => {
    setLoading(true);
    try {
      const [rolesRes, catRes] = await Promise.all([
        apiGet<Role[]>('/api/roles-permissions/roles'),
        apiGet<Catalog>('/api/roles-permissions/permissions'),
      ]);
      const list = rolesRes.data ?? [];
      setRoles(list);
      setCatalog(catRes.data ?? null);
      setSelectedId((prev) => prev ?? list[0]?.id ?? null);
    } catch (err) {
      setMessage({ tone: 'err', text: err instanceof Error ? err.message : 'Could not load roles.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => { if (selected) setDraft(new Set(selected.permissionKeys)); }, [selected]);

  const dirty = useMemo(() => {
    if (!selected) return false;
    const original = new Set(selected.permissionKeys);
    return original.size !== draft.size || [...draft].some((k) => !original.has(k));
  }, [selected, draft]);

  const toggle = (key: string) => {
    if (!canManage) return;
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleCategory = (category: string) => {
    if (!canManage || !catalog) return;
    const keys = catalog.grouped[category]?.map((p) => p.key) ?? [];
    const allOn = keys.every((k) => draft.has(k));
    setDraft((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => (allOn ? next.delete(k) : next.add(k)));
      return next;
    });
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    setMessage(null);
    try {
      await apiPut(`/api/roles-permissions/roles/${selected.id}`, { permissionKeys: [...draft] });
      setMessage({ tone: 'ok', text: `Saved ${draft.size} permission(s) for ${selected.name}.` });
      await load();
      // The caller may have just changed their own role's permissions.
      await refreshPermissions();
    } catch (err) {
      setMessage({ tone: 'err', text: err instanceof Error ? err.message : 'Could not save.' });
    } finally {
      setSaving(false);
    }
  };

  const create = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await apiPost<Role>('/api/roles-permissions/roles', { ...newRole, permissionKeys: [] });
      setCreating(false);
      setNewRole({ name: '', level: 'STAFF', description: '' });
      await load();
      if (res.data) setSelectedId(res.data.id);
    } catch (err) {
      setMessage({ tone: 'err', text: err instanceof Error ? err.message : 'Could not create the role.' });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (role: Role) => {
    if (!confirm(`Delete the role "${role.name}"? This cannot be undone.`)) return;
    try {
      await apiDelete(`/api/roles-permissions/roles/${role.id}`);
      setSelectedId(null);
      await load();
    } catch (err) {
      setMessage({ tone: 'err', text: err instanceof Error ? err.message : 'Could not delete the role.' });
    }
  };

  if (loading) return <div className="grid h-full place-items-center"><Spinner /></div>;

  return (
    <div className="px-4 pb-24 pt-5 sm:px-6 sm:pt-6">
      <PageHeader
        title="Roles & permissions"
        subtitle="A role carries a permission set; every user holds one role. Changes take effect on the user's next request — no re-login needed."
        actions={canManage ? (
          <Button onClick={() => setCreating(true)}><Plus size={15} /> New role</Button>
        ) : undefined}
      />

      {message && (
        <div className={`mb-4 rounded-lg px-4 py-2.5 text-sm ${
          message.tone === 'ok'
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
            : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
        }`}>{message.text}</div>
      )}

      {creating && (
        <Card className="mb-4 p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_2fr_auto]">
            <input
              autoFocus placeholder="Role name" value={newRole.name}
              onChange={(e) => setNewRole({ ...newRole, name: e.target.value })}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-border-dark dark:bg-chrome-dark dark:text-slate-100"
            />
            <select
              value={newRole.level}
              onChange={(e) => setNewRole({ ...newRole, level: e.target.value })}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-border-dark dark:bg-chrome-dark dark:text-slate-100"
            >
              {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <input
              placeholder="Description (optional)" value={newRole.description}
              onChange={(e) => setNewRole({ ...newRole, description: e.target.value })}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-border-dark dark:bg-chrome-dark dark:text-slate-100"
            />
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
            {roles.map((role) => (
              <li key={role.id}>
                <button
                  onClick={() => setSelectedId(role.id)}
                  className={`flex w-full items-start gap-2 px-4 py-3 text-left transition-colors ${
                    role.id === selectedId
                      ? 'bg-blue-50 dark:bg-card-dark'
                      : 'hover:bg-slate-50 dark:hover:bg-card-dark/50'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{role.name}</span>
                      {role.isSystem && <Lock size={11} className="shrink-0 text-slate-400" />}
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
            ))}
          </ul>
        </Card>

        {selected && catalog && (
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-border-dark">
              <div>
                <div className="flex items-center gap-2">
                  <ShieldCheck size={16} className="text-blue-600 dark:text-blue-400" />
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{selected.name}</h2>
                  {selected.isSystem && <Badge tone="slate">System role</Badge>}
                </div>
                {selected.description && (
                  <p className="mt-1 max-w-xl text-xs text-slate-500 dark:text-slate-400">{selected.description}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {canManage && !selected.isSystem && (
                  <Button variant="ghost" size="sm" onClick={() => remove(selected)}>
                    <Trash2 size={14} /> Delete
                  </Button>
                )}
                {canManage && (
                  <Button size="sm" onClick={save} disabled={!dirty || saving}>
                    <Save size={14} /> {saving ? 'Saving…' : dirty ? `Save (${draft.size})` : 'Saved'}
                  </Button>
                )}
              </div>
            </div>

            {!canManage && (
              <p className="border-b border-slate-100 bg-slate-50 px-5 py-2 text-xs text-slate-500 dark:border-border-dark dark:bg-chrome-dark/50 dark:text-slate-400">
                You have read-only access to roles. ROLES_PERMISSIONS_MANAGE is required to edit them.
              </p>
            )}

            <div className="divide-y divide-slate-100 dark:divide-border-dark">
              {catalog.categoryOrder.map((category) => {
                const perms = catalog.grouped[category] ?? [];
                const onCount = perms.filter((p) => draft.has(p.key)).length;
                return (
                  <section key={category} className="px-5 py-4">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        {category}
                      </h3>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-400">{onCount}/{perms.length}</span>
                        {canManage && (
                          <button
                            onClick={() => toggleCategory(category)}
                            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                          >
                            {onCount === perms.length ? 'Clear all' : 'Select all'}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {perms.map((p) => (
                        <label
                          key={p.key}
                          title={p.description}
                          className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm ${
                            canManage ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-card-dark/50' : 'cursor-default'
                          }`}
                        >
                          <input
                            type="checkbox" checked={draft.has(p.key)} disabled={!canManage}
                            onChange={() => toggle(p.key)}
                            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-border-dark"
                          />
                          <span className="min-w-0">
                            <span className="block font-mono text-xs text-slate-700 dark:text-slate-200">{p.key}</span>
                            <span className="block text-xs leading-snug text-slate-400">{p.description}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
};
