import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, RefreshCw, Users, Loader2, X } from 'lucide-react';
import { Button, IconButton, PageHeader, Spinner, EmptyState, Badge } from '../../components/ui';
import * as api from './api';
import type { MailDistributionList } from '@tupo/shared';

const ORIGINS: Array<{ value: string; label: string }> = [
  { value: 'manual', label: 'Manual — I add members myself' },
  { value: 'mis:all', label: 'Everyone (all active accounts)' },
  { value: 'mis:space:staff', label: 'All Staff' },
  { value: 'mis:space:students', label: 'All Students' },
  { value: 'mis:space:parents', label: 'All Parents' },
  { value: 'mis:role:Staff', label: 'Role: Staff' },
  { value: 'mis:role:Parent', label: 'Role: Parent' },
  { value: 'mis:role:Student', label: 'Role: Student' },
];

export const MailLists: React.FC = () => {
  const navigate = useNavigate();
  const [lists, setLists] = useState<MailDistributionList[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [members, setMembers] = useState<Array<{ address: string; name: string; source: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', origin: 'manual' });
  const [newMember, setNewMember] = useState({ address: '', name: '' });
  const [syncing, setSyncing] = useState<string | null>(null);

  const load = () => api.listLists().then(setLists).catch(() => setLists([]));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (open) api.listMembers(open).then(setMembers).catch(() => setMembers([])); }, [open]);

  const create = async () => {
    if (!form.name.trim()) return;
    await api.createList(form).catch(() => {});
    setCreating(false); setForm({ name: '', description: '', origin: 'manual' }); load();
  };

  const sync = async (id: string) => {
    setSyncing(id);
    await api.syncList(id).catch(() => {});
    setSyncing(null); load();
    if (open === id) api.listMembers(id).then(setMembers);
  };

  if (lists === null) return <div className="grid h-full place-items-center"><Spinner /></div>;

  const active = lists.find((l) => l.id === open);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <button onClick={() => navigate('/app/mail')} className="mb-3 inline-flex items-center gap-1 text-sm text-blue-600"><ArrowLeft size={15} /> Back to mail</button>
      <PageHeader
        title="Distribution lists"
        subtitle="Address a whole audience at once. Synced lists refresh automatically from the directory."
        actions={<Button onClick={() => setCreating(true)}><Plus size={15} /> New list</Button>}
      />

      {creating && (
        <div className="mb-4 space-y-2 rounded-xl border border-border-light p-4 dark:border-border-dark/50">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="List name"
            className="w-full rounded-lg border border-border-light bg-transparent px-3 py-2 text-sm dark:border-border-dark/60" />
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Description"
            className="w-full rounded-lg border border-border-light bg-transparent px-3 py-2 text-sm dark:border-border-dark/60" />
          <select value={form.origin} onChange={(e) => setForm({ ...form, origin: e.target.value })}
            className="w-full rounded-lg border border-border-light bg-transparent px-3 py-2 text-sm dark:border-border-dark/60">
            {ORIGINS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <div className="flex gap-2"><Button size="sm" onClick={create}>Create</Button><Button size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button></div>
        </div>
      )}

      {lists.length === 0 ? (
        <EmptyState icon={<Users />} title="No distribution lists" hint="Create one to send announcements to a whole group." />
      ) : (
        <ul className="divide-y divide-border-light rounded-xl border border-border-light dark:divide-border-dark/40 dark:border-border-dark/50">
          {lists.map((l) => (
            <li key={l.id} className="p-4">
              <div className="flex items-center gap-3">
                <button onClick={() => setOpen(open === l.id ? null : l.id)} className="min-w-0 flex-1 text-left">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{l.name}</span>
                    <Badge tone={l.origin === 'manual' ? 'slate' : 'blue'}>{l.origin === 'manual' ? 'manual' : 'synced'}</Badge>
                  </span>
                  <span className="block truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">
                    {l.memberCount} {l.memberCount === 1 ? 'member' : 'members'}
                    {l.description && ` · ${l.description}`}
                  </span>
                </button>
                {l.origin !== 'manual' && (
                  <IconButton label="Sync now" size="sm" onClick={() => sync(l.id)}>
                    {syncing === l.id ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                  </IconButton>
                )}
                <IconButton label="Delete list" size="sm" onClick={() => api.deleteList(l.id).then(load)}><Trash2 size={15} /></IconButton>
              </div>

              {open === l.id && (
                <div className="mt-3 rounded-lg bg-surface-light/60 p-3 dark:bg-surface-dark/40">
                  {active?.origin === 'manual' && (
                    <div className="mb-2 flex gap-1.5">
                      <input value={newMember.name} onChange={(e) => setNewMember({ ...newMember, name: e.target.value })} placeholder="Name"
                        className="w-28 rounded-lg border border-border-light bg-white px-2 py-1 text-xs dark:border-border-dark/60 dark:bg-transparent" />
                      <input value={newMember.address} onChange={(e) => setNewMember({ ...newMember, address: e.target.value })} placeholder="email@address"
                        className="flex-1 rounded-lg border border-border-light bg-white px-2 py-1 text-xs dark:border-border-dark/60 dark:bg-transparent" />
                      <button onClick={async () => { await api.addMember(l.id, newMember).catch(() => {}); setNewMember({ address: '', name: '' }); api.listMembers(l.id).then(setMembers); load(); }}
                        className="rounded-lg bg-blue-600 px-2 text-xs text-white">Add</button>
                    </div>
                  )}
                  <ul className="max-h-56 space-y-0.5 overflow-y-auto text-xs">
                    {members.length === 0 && <li className="py-2 text-text-secondary-light">No members. {active?.origin !== 'manual' && 'Try Sync now.'}</li>}
                    {members.map((m) => (
                      <li key={m.address} className="flex items-center gap-2 py-1">
                        <span className="flex-1 truncate">{m.name} <span className="text-text-secondary-light">· {m.address}</span></span>
                        {active?.origin === 'manual' && (
                          <button aria-label="Remove" onClick={() => api.removeMember(l.id, m.address).then(() => { api.listMembers(l.id).then(setMembers); load(); })}><X size={12} /></button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default MailLists;
