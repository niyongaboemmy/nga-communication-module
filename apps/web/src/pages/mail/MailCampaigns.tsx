import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Plus, Megaphone, Send, Eye, Check, X, Loader2, Clock, AlertTriangle, Trash2, Sparkles,
} from 'lucide-react';
import { Button, IconButton, PageHeader, Spinner, EmptyState, Badge } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../context/AuthContext';
import { RichTextEditor } from './RichTextEditor';
import * as api from './api';
import type { MailCampaignView, MailDistributionList, MailTemplate } from '@tupo/shared';
import './mail.css';

const STATUS_TONE: Record<string, 'slate' | 'blue' | 'amber' | 'green' | 'red'> = {
  draft: 'slate', pending_approval: 'amber', approved: 'blue', scheduled: 'blue',
  sending: 'blue', sent: 'green', failed: 'red', cancelled: 'slate',
};

const CountsBar: React.FC<{ counts: Record<string, number>; total: number }> = ({ counts, total }) => {
  const seg = (n: number, c: string) => (n > 0 ? <span className={c} style={{ flex: n }} /> : null);
  return (
    <div className="mt-1.5">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-light dark:bg-surface-dark">
        {seg(counts.delivered ?? 0, 'bg-emerald-500')}
        {seg(counts.sent ?? 0, 'bg-blue-400')}
        {seg((counts.bounced ?? 0) + (counts.failed ?? 0), 'bg-red-500')}
        {seg(counts.queued ?? 0, 'bg-slate-300')}
      </div>
      <p className="mt-1 text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
        {counts.delivered ?? 0} delivered · {(counts.bounced ?? 0) + (counts.failed ?? 0)} failed · {total} total
      </p>
    </div>
  );
};

const Editor: React.FC<{
  campaign?: MailCampaignView; lists: MailDistributionList[]; templates: MailTemplate[];
  onDone: () => void; onCancel: () => void;
}> = ({ campaign, lists, templates, onDone, onCancel }) => {
  const [subject, setSubject] = useState(campaign?.subject ?? '');
  const [name, setName] = useState(campaign?.name ?? '');
  const [body, setBody] = useState(campaign?.bodyHtml ?? '');
  const [listIds, setListIds] = useState<string[]>(campaign?.listIds ?? []);
  const [templateId, setTemplateId] = useState<string>(campaign?.templateId ?? '');
  const [scheduledAt, setScheduledAt] = useState(campaign?.scheduledAt ? campaign.scheduledAt.slice(0, 16) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [brief, setBrief] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => { api.aiStatus().then(setAiAvailable).catch(() => setAiAvailable(false)); }, []);

  const draftWithAi = async () => {
    if (!brief.trim()) return;
    setAiBusy(true); setError(null);
    try {
      const audience = lists.filter((l) => listIds.includes(l.id)).map((l) => l.name).join(', ');
      const r = await api.aiCampaign(brief, audience || undefined);
      setSubject(r.subject); setBody(r.bodyHtml);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The assistant could not draft that.');
    } finally { setAiBusy(false); }
  };

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) { setSubject((s) => s || t.subject); setBody(t.bodyHtml); }
  };

  const save = async () => {
    if (!subject.trim()) { setError('A subject is required.'); return; }
    if (!listIds.length) { setError('Choose at least one distribution list.'); return; }
    setBusy(true); setError(null);
    try {
      const payload = {
        name: name || subject, subject, bodyHtml: body, listIds,
        templateId: templateId || null,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
      };
      if (campaign) await api.updateCampaign(campaign.id, payload);
      else await api.createCampaign(payload);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.'); setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <button onClick={onCancel} className="mb-4 inline-flex items-center gap-1 text-sm text-blue-600"><ArrowLeft size={15} /> Back</button>
      <h1 className="mb-4 text-xl font-semibold">{campaign ? 'Edit campaign' : 'New bulk announcement'}</h1>
      <div className="space-y-3">
        {aiAvailable && (
          <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-3 dark:border-blue-900/50 dark:bg-blue-900/15">
            <label className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-blue-700 dark:text-blue-300">
              <Sparkles size={13} /> Draft with AI
            </label>
            <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={2}
              placeholder="Describe the announcement — e.g. 'Remind Term 2 parents that fees are due 15 Feb; direct questions to the bursary.'"
              className="w-full resize-none rounded-lg border border-border-light bg-white px-2.5 py-2 text-sm dark:border-border-dark/60 dark:bg-transparent" />
            <button onClick={draftWithAi} disabled={aiBusy || !brief.trim()}
              className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50">
              {aiBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Generate subject & body
            </button>
          </div>
        )}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Internal name (optional)"
          className="w-full rounded-xl border border-border-light bg-transparent px-3 py-2 text-sm dark:border-border-dark/60" />
        <div>
          <label className="mb-1 block text-xs font-medium text-text-secondary-light">Start from a template</label>
          <select value={templateId} onChange={(e) => applyTemplate(e.target.value)}
            className="w-full rounded-xl border border-border-light bg-transparent px-3 py-2 text-sm dark:border-border-dark/60">
            <option value="">— none —</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject — {{name}} etc. filled per recipient"
          className="w-full rounded-xl border border-border-light bg-transparent px-3 py-2 text-sm dark:border-border-dark/60" />
        <div>
          <label className="mb-1 block text-xs font-medium text-text-secondary-light">Distribution lists</label>
          <div className="flex flex-wrap gap-2">
            {lists.map((l) => (
              <button key={l.id} onClick={() => setListIds((s) => s.includes(l.id) ? s.filter((x) => x !== l.id) : [...s, l.id])}
                className={`rounded-full border px-3 py-1 text-xs ${listIds.includes(l.id) ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'border-border-light dark:border-border-dark/60'}`}>
                {l.name} <span className="opacity-60">({l.memberCount})</span>
              </button>
            ))}
            {lists.length === 0 && <span className="text-xs text-text-secondary-light">No lists — create one first.</span>}
          </div>
        </div>
        <RichTextEditor value={body} onChange={setBody} placeholder="Announcement body. Use {{name}}, {{first_name}} and custom fields." />
        <div>
          <label className="mb-1 block text-xs font-medium text-text-secondary-light">Schedule (optional)</label>
          <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)}
            className="rounded-xl border border-border-light bg-transparent px-3 py-2 text-sm dark:border-border-dark/60" />
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <Button onClick={save} disabled={busy}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save draft</Button>
      </div>
    </div>
  );
};

const PreviewModal: React.FC<{ campaignId: string; onClose: () => void; onSubmitted: () => void }> = ({ campaignId, onClose, onSubmitted }) => {
  const [preview, setPreview] = useState<api.CampaignPreview | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.previewCampaign(campaignId).then(setPreview).catch(() => setPreview(null)); }, [campaignId]);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-5 shadow-2xl dark:bg-elevated-dark" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Preview & send</h3>
          <IconButton label="Close" size="sm" onClick={onClose}><X size={18} /></IconButton>
        </div>
        {!preview ? <div className="grid h-32 place-items-center"><Spinner /></div> : (
          <>
            <div className="mb-3 flex flex-wrap gap-3 text-sm">
              <span className="rounded-lg bg-surface-light px-3 py-1.5 dark:bg-surface-dark"><strong>{preview.totalRecipients}</strong> recipients</span>
              {preview.requiresApproval && (
                <span className="inline-flex items-center gap-1 rounded-lg bg-amber-50 px-3 py-1.5 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                  <AlertTriangle size={14} /> Over 200 — needs approval
                </span>
              )}
            </div>
            {preview.missingFields.length > 0 && (
              <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">
                Some recipients are missing merge values for: {preview.missingFields.map((f) => `{{${f}}}`).join(', ')}. They will render blank.
              </p>
            )}
            <p className="mb-2 text-xs font-medium text-text-secondary-light">Sample renders</p>
            <div className="space-y-3">
              {preview.samples.map((s, i) => (
                <div key={i} className="rounded-lg border border-border-light p-3 dark:border-border-dark/50">
                  <p className="text-xs text-text-secondary-light">To: {s.to}</p>
                  <p className="mb-1 text-sm font-semibold">{s.subject}</p>
                  <div className="tupo-prose max-w-none text-sm" dangerouslySetInnerHTML={{ __html: s.bodyHtml }} />
                </div>
              ))}
              {preview.samples.length === 0 && <p className="text-sm text-text-secondary-light">No deliverable recipients.</p>}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button disabled={busy || preview.totalRecipients === 0} onClick={async () => {
                setBusy(true);
                try { await api.submitCampaign(campaignId); onSubmitted(); }
                catch { setBusy(false); }
              }}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                {preview.requiresApproval ? 'Submit for approval' : 'Send now'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export const MailCampaigns: React.FC = () => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { user } = useAuth();
  const canApprove = can('MAIL_APPROVE');
  const canSend = can('MAIL_BULK_SEND');

  const [campaigns, setCampaigns] = useState<MailCampaignView[] | null>(null);
  const [lists, setLists] = useState<MailDistributionList[]>([]);
  const [templates, setTemplates] = useState<MailTemplate[]>([]);
  const [mode, setMode] = useState<'list' | 'new' | { edit: MailCampaignView }>('list');
  const [preview, setPreview] = useState<string | null>(null);

  const load = () => api.listCampaigns().then(setCampaigns).catch(() => setCampaigns([]));
  useEffect(() => {
    load();
    api.listLists().then(setLists).catch(() => {});
    api.listTemplates().then(setTemplates).catch(() => {});
    const iv = setInterval(load, 8000);
    return () => clearInterval(iv);
  }, []);

  // Your own bulk sends are never yours to approve — the server refuses a
  // self-approval — so they stay out of the approval queue and simply show as
  // "pending approval" in the list below until another approver acts.
  const pending = useMemo(
    () => campaigns?.filter((c) => c.status === 'pending_approval' && c.from.userId !== user?.id) ?? [],
    [campaigns, user?.id],
  );

  if (campaigns === null) return <div className="grid h-full place-items-center"><Spinner /></div>;

  if (mode === 'new') return <Editor lists={lists} templates={templates} onDone={() => { setMode('list'); load(); }} onCancel={() => setMode('list')} />;
  if (typeof mode === 'object') return <Editor campaign={mode.edit} lists={lists} templates={templates} onDone={() => { setMode('list'); load(); }} onCancel={() => setMode('list')} />;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <button onClick={() => navigate('/app/mail')} className="mb-3 inline-flex items-center gap-1 text-sm text-blue-600"><ArrowLeft size={15} /> Back to mail</button>
      <PageHeader
        title="Bulk announcements"
        subtitle="Send a templated message to distribution lists, with a preview and per-recipient delivery tracking."
        actions={canSend ? <Button onClick={() => setMode('new')}><Plus size={15} /> New campaign</Button> : undefined}
      />

      {canApprove && pending.length > 0 && (
        <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
          <p className="mb-2 text-sm font-semibold text-amber-800 dark:text-amber-200">Awaiting your approval</p>
          <ul className="space-y-2">
            {pending.map((c) => (
              <li key={c.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{c.subject} <span className="text-text-secondary-light">· {c.totalRecipients} recipients · {c.from.name}</span></span>
                <Button size="sm" onClick={() => api.approveCampaign(c.id).then(load)}><Check size={13} /> Approve</Button>
                <Button size="sm" variant="ghost" onClick={() => { const r = window.prompt('Reason for sending back'); if (r) api.rejectCampaign(c.id, r).then(load); }}>Reject</Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {campaigns.length === 0 ? (
        <EmptyState icon={<Megaphone />} title="No campaigns yet" hint="Create one to reach a whole distribution list at once." />
      ) : (
        <ul className="space-y-2">
          {campaigns.map((c) => (
            <li key={c.id} className="rounded-xl border border-border-light p-4 dark:border-border-dark/50">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{c.subject || c.name}</span>
                    <Badge tone={STATUS_TONE[c.status]}>{c.status.replace('_', ' ')}</Badge>
                    {c.scheduledAt && ['scheduled', 'approved'].includes(c.status) && (
                      <span className="inline-flex items-center gap-1 text-xs text-text-secondary-light"><Clock size={11} /> {new Date(c.scheduledAt).toLocaleString()}</span>
                    )}
                  </div>
                  <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
                    {c.from.name} · {c.totalRecipients || '—'} recipients{c.rejectedReason && ` · sent back: ${c.rejectedReason}`}
                    {c.status === 'pending_approval' && c.from.userId === user?.id && ' · waiting for another approver'}
                  </p>
                  {['sending', 'sent', 'failed'].includes(c.status) && <CountsBar counts={c.counts} total={c.totalRecipients} />}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {['draft'].includes(c.status) && canSend && (
                    <>
                      <IconButton label="Edit" size="sm" onClick={() => setMode({ edit: c })}><Eye size={15} /></IconButton>
                      <Button size="sm" onClick={() => setPreview(c.id)}><Send size={13} /> Review & send</Button>
                    </>
                  )}
                  {['draft', 'pending_approval', 'scheduled', 'approved'].includes(c.status) && canSend && (
                    <IconButton label="Cancel" size="sm" onClick={() => api.cancelCampaign(c.id).then(load)}><Trash2 size={15} /></IconButton>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {preview && <PreviewModal campaignId={preview} onClose={() => setPreview(null)} onSubmitted={() => { setPreview(null); load(); }} />}
    </div>
  );
};

export default MailCampaigns;
