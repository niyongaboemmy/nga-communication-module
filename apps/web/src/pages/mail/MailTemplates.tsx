import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Save, Loader2 } from 'lucide-react';
import { Button, IconButton, PageHeader, Spinner, EmptyState } from '../../components/ui';
import { RichTextEditor } from './RichTextEditor';
import * as api from './api';
import type { MailTemplate } from '@tupo/shared';
import './mail.css';

const CATEGORIES = ['general', 'fees', 'academic', 'events', 'admin'];

export const MailTemplates: React.FC = () => {
  const navigate = useNavigate();
  const [items, setItems] = useState<MailTemplate[] | null>(null);
  const [editing, setEditing] = useState<Partial<MailTemplate> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.listTemplates().then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing?.name?.trim() || !editing.subject?.trim()) { setError('Name and subject are required.'); return; }
    setBusy(true); setError(null);
    try {
      const body = {
        name: editing.name, description: editing.description ?? '', category: editing.category ?? 'general',
        subject: editing.subject, bodyHtml: editing.bodyHtml ?? '',
      };
      if (editing.id) await api.updateTemplate(editing.id, body);
      else await api.createTemplate(body);
      setEditing(null); load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally { setBusy(false); }
  };

  if (items === null) return <div className="grid h-full place-items-center"><Spinner /></div>;

  if (editing) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <button onClick={() => setEditing(null)} className="mb-4 inline-flex items-center gap-1 text-sm text-blue-600"><ArrowLeft size={15} /> Back to templates</button>
        <h1 className="mb-4 text-xl font-semibold">{editing.id ? 'Edit template' : 'New template'}</h1>
        <div className="space-y-3">
          <input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            placeholder="Template name" className="w-full rounded-xl border border-border-light bg-transparent px-3 py-2 text-sm dark:border-border-dark/60" />
          <input value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            placeholder="What is it for?" className="w-full rounded-xl border border-border-light bg-transparent px-3 py-2 text-sm dark:border-border-dark/60" />
          <select value={editing.category ?? 'general'} onChange={(e) => setEditing({ ...editing, category: e.target.value })}
            className="rounded-xl border border-border-light bg-transparent px-3 py-2 text-sm dark:border-border-dark/60">
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input value={editing.subject ?? ''} onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
            placeholder="Subject — use {{name}}, {{term}}, …" className="w-full rounded-xl border border-border-light bg-transparent px-3 py-2 text-sm dark:border-border-dark/60" />
          <RichTextEditor value={editing.bodyHtml ?? ''} onChange={(html) => setEditing({ ...editing, bodyHtml: html })}
            placeholder="Template body. Insert merge fields with {{double_braces}}." />
          <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
            Merge fields like <code>{'{{name}}'}</code>, <code>{'{{first_name}}'}</code> and any custom field on a distribution list are filled in per recipient at send time.
          </p>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <Button onClick={save} disabled={busy}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save template</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <button onClick={() => navigate('/app/mail')} className="mb-3 inline-flex items-center gap-1 text-sm text-blue-600"><ArrowLeft size={15} /> Back to mail</button>
      <PageHeader
        title="Mail templates"
        subtitle="Reusable rich-text messages for fee notices, term letters and event invitations."
        actions={<Button onClick={() => setEditing({ category: 'general' })}><Plus size={15} /> New template</Button>}
      />
      {items.length === 0 ? (
        <EmptyState title="No templates yet" hint="Create one to speed up recurring communications." />
      ) : (
        <ul className="divide-y divide-border-light rounded-xl border border-border-light dark:divide-border-dark/40 dark:border-border-dark/50">
          {items.map((t) => (
            <li key={t.id} className="flex items-center gap-3 p-4">
              <span className="rounded bg-surface-light px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary-light dark:bg-surface-dark">{t.category}</span>
              <button onClick={() => setEditing(t)} className="min-w-0 flex-1 text-left">
                <span className="block truncate font-medium">{t.name}</span>
                <span className="block truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">{t.subject}</span>
              </button>
              {t.variables.length > 0 && (
                <span className="hidden text-xs text-text-secondary-light sm:block">{t.variables.map((v) => `{{${v}}}`).join(' ')}</span>
              )}
              <IconButton label="Delete" size="sm" onClick={() => api.deleteTemplate(t.id).then(load)}><Trash2 size={15} /></IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default MailTemplates;
