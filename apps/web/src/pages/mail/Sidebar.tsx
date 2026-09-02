import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Inbox, Star, Send, FileEdit, Clock, Archive, Trash2, Ban, PenSquare, Tag, Plus,
  Users, LayoutTemplate, Megaphone, Settings, X,
} from 'lucide-react';
import { Button, UnreadBadge } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import type { MailFolder, MailLabel, MailboxCounts } from '@tupo/shared';
import * as api from './api';

interface Props {
  folder: MailFolder;
  labelId: string | null;
  counts: MailboxCounts;
  labels: MailLabel[];
  onSelectFolder: (f: MailFolder) => void;
  onSelectLabel: (id: string) => void;
  onCompose: () => void;
  onLabelsChanged: () => void;
  onNavigate?: () => void;
}

const FOLDERS: Array<{ key: MailFolder; label: string; icon: React.ElementType; countKey?: keyof MailboxCounts }> = [
  { key: 'inbox', label: 'Inbox', icon: Inbox, countKey: 'inbox' },
  { key: 'starred', label: 'Starred', icon: Star, countKey: 'starred' },
  { key: 'sent', label: 'Sent', icon: Send },
  { key: 'drafts', label: 'Drafts', icon: FileEdit, countKey: 'drafts' },
  { key: 'scheduled', label: 'Scheduled', icon: Clock, countKey: 'scheduled' },
  { key: 'archive', label: 'Archive', icon: Archive },
  { key: 'spam', label: 'Spam', icon: Ban },
  { key: 'trash', label: 'Trash', icon: Trash2 },
];

const LABEL_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'];

export const Sidebar: React.FC<Props> = ({
  folder, labelId, counts, labels, onSelectFolder, onSelectLabel, onCompose, onLabelsChanged, onNavigate,
}) => {
  const { can } = usePermissions();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(LABEL_COLORS[3]!);

  const addLabel = async () => {
    if (!name.trim()) return;
    await api.createLabel(name.trim(), color).catch(() => {});
    setName(''); setAdding(false); onLabelsChanged();
  };

  const row = 'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors';
  const activeRow = 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
  const idleRow = 'text-text-secondary-light hover:bg-surface-light hover:text-text-primary-light dark:text-text-secondary-dark dark:hover:bg-surface-dark';

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto p-3">
      <Button className="mb-2 w-full justify-center" onClick={() => { onCompose(); onNavigate?.(); }}>
        <PenSquare size={16} /> Compose
      </Button>

      {FOLDERS.map(({ key, label, icon: Icon, countKey }) => {
        const n = countKey ? counts[countKey] : 0;
        const active = folder === key && !labelId;
        return (
          <button key={key} onClick={() => { onSelectFolder(key); onNavigate?.(); }} className={`${row} ${active ? activeRow : idleRow}`}>
            <Icon size={17} />
            <span className="flex-1 text-left">{label}</span>
            {n > 0 && <UnreadBadge count={n} />}
          </button>
        );
      })}

      <div className="mt-3 flex items-center justify-between px-3 py-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">Labels</span>
        <button aria-label="Add label" onClick={() => setAdding((v) => !v)} className="text-text-secondary-light hover:text-blue-600">
          <Plus size={14} />
        </button>
      </div>

      {adding && (
        <div className="mb-1 flex items-center gap-1.5 px-2">
          <div className="flex gap-1">
            {LABEL_COLORS.map((c) => (
              <button key={c} aria-label={`Colour ${c}`} onClick={() => setColor(c)} style={{ background: c }}
                className={`h-4 w-4 rounded-full ${color === c ? 'ring-2 ring-offset-1 ring-blue-500' : ''}`} />
            ))}
          </div>
        </div>
      )}
      {adding && (
        <div className="mb-2 flex gap-1 px-2">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addLabel()}
            placeholder="Label name"
            className="flex-1 rounded-lg border border-border-light bg-transparent px-2 py-1 text-sm dark:border-border-dark/60" />
          <button onClick={addLabel} className="rounded-lg bg-blue-600 px-2 text-xs text-white">Add</button>
        </div>
      )}

      {labels.map((l) => (
        <div key={l.id} className={`${row} group ${labelId === l.id ? activeRow : idleRow}`}>
          <button onClick={() => { onSelectLabel(l.id); onNavigate?.(); }} className="flex flex-1 items-center gap-3">
            <Tag size={16} style={{ color: l.color }} />
            <span className="flex-1 text-left">{l.name}</span>
            {(l.unread ?? 0) > 0 && <UnreadBadge count={l.unread!} />}
          </button>
          {!l.isSystem && (
            <button aria-label={`Delete ${l.name}`} onClick={() => api.deleteLabel(l.id).then(onLabelsChanged)}
              className="hidden text-text-secondary-light hover:text-red-600 group-hover:block">
              <X size={13} />
            </button>
          )}
        </div>
      ))}

      <div className="mt-4 border-t border-border-light pt-2 dark:border-border-dark/50">
        {(can('MAIL_BULK_SEND') || can('MAIL_APPROVE')) && (
          <NavLink to="/app/mail/campaigns" onClick={onNavigate} className={({ isActive }) => `${row} ${isActive ? activeRow : idleRow}`}>
            <Megaphone size={17} /> <span className="flex-1 text-left">Campaigns</span>
          </NavLink>
        )}
        {can('MAIL_LIST_MANAGE') && (
          <NavLink to="/app/mail/lists" onClick={onNavigate} className={({ isActive }) => `${row} ${isActive ? activeRow : idleRow}`}>
            <Users size={17} /> <span className="flex-1 text-left">Distribution lists</span>
          </NavLink>
        )}
        {can('MAIL_TEMPLATE_MANAGE') && (
          <NavLink to="/app/mail/templates" onClick={onNavigate} className={({ isActive }) => `${row} ${isActive ? activeRow : idleRow}`}>
            <LayoutTemplate size={17} /> <span className="flex-1 text-left">Templates</span>
          </NavLink>
        )}
        <NavLink to="/app/mail/settings" onClick={onNavigate} className={({ isActive }) => `${row} ${isActive ? activeRow : idleRow}`}>
          <Settings size={17} /> <span className="flex-1 text-left">Mail settings</span>
        </NavLink>
      </div>
    </div>
  );
};
