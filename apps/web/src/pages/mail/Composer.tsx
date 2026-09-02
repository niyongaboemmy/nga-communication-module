import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Minus, Maximize2, Paperclip, Trash2, Clock, Send, ChevronDown, FileText, Loader2,
  Sparkles, Undo2, Wand2,
} from 'lucide-react';
import { Button, IconButton } from '../../components/ui';
import { RichTextEditor } from './RichTextEditor';
import { RecipientInput, type RecipientToken } from './RecipientInput';
import { AiAssistant, htmlToPlain } from './AiAssistant';
import * as api from './api';
import type { MailComposePayload, MailMessageKind, MailTemplate } from '@tupo/shared';

export interface ComposerSeed {
  to?: RecipientToken[];
  cc?: RecipientToken[];
  bcc?: RecipientToken[];
  subject?: string;
  bodyHtml?: string;
  threadId?: string;
  parentId?: string;
  kind?: MailMessageKind;
  draftId?: string;
  scheduledAt?: string | null;
}

interface Props {
  seed?: ComposerSeed;
  signatureHtml?: string;
  onClose: () => void;
  onSent: (result: { threadId: string; scheduled: boolean; draft: boolean }) => void;
}

type Att = { fileId: string; name: string; mime: string; size: number };

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1e6 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1e6).toFixed(1)} MB`);

export const Composer: React.FC<Props> = ({ seed, signatureHtml, onClose, onSent }) => {
  const [to, setTo] = useState<RecipientToken[]>(seed?.to ?? []);
  const [cc, setCc] = useState<RecipientToken[]>(seed?.cc ?? []);
  const [bcc, setBcc] = useState<RecipientToken[]>(seed?.bcc ?? []);
  const [showCc, setShowCc] = useState((seed?.cc?.length ?? 0) + (seed?.bcc?.length ?? 0) > 0);
  const [subject, setSubject] = useState(seed?.subject ?? '');
  const initialBody = seed?.bodyHtml ?? (signatureHtml ? `<p></p><p></p>${signatureHtml}` : '');
  const [body, setBody] = useState(initialBody);
  const [attachments, setAttachments] = useState<Att[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState<null | 'send' | 'draft' | 'schedule'>(null);
  const [error, setError] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [scheduleAt, setScheduleAt] = useState<string>('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [templates, setTemplates] = useState<MailTemplate[] | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [undoBody, setUndoBody] = useState<string | null>(null);
  const [subjectIdeas, setSubjectIdeas] = useState<string[] | null>(null);
  const [subjectBusy, setSubjectBusy] = useState(false);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const draftIdRef = useRef<string | undefined>(seed?.draftId);
  const fileRef = useRef<HTMLInputElement>(null);

  const kind: MailMessageKind = seed?.kind ?? 'new';

  const payloadBase = (): MailComposePayload => ({
    to, cc, bcc, subject, bodyHtml: body,
    attachments, threadId: seed?.threadId, parentId: seed?.parentId, kind,
    draftId: draftIdRef.current,
  });

  // Autosave a draft every 4s once there is anything worth keeping.
  useEffect(() => {
    const hasContent = to.length || subject.trim() || body.replace(/<[^>]+>/g, '').trim();
    if (!hasContent) return;
    const t = setTimeout(async () => {
      try {
        const r = await api.compose({ ...payloadBase(), draft: true });
        draftIdRef.current = r.messageId;
      } catch { /* autosave is best-effort */ }
    }, 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, body, attachments]);

  useEffect(() => { api.aiStatus().then(setAiAvailable).catch(() => setAiAvailable(false)); }, []);

  const applyAi = (html: string) => {
    setUndoBody(bodyRef.current);
    // For a reply/draft the assistant returns the whole message; for a rewrite
    // it also returns the whole message — either way we replace, and keep the
    // previous version one Undo away.
    setBody(html);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        if (f.size > 25 * 1024 * 1024) { setError(`${f.name} is larger than 25 MB.`); continue; }
        const uploaded = await api.uploadAttachment(f);
        setAttachments((a) => [...a, uploaded]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const doSend = async (mode: 'send' | 'schedule') => {
    setError(null);
    if (!to.length && !cc.length && !bcc.length) { setError('Add at least one recipient.'); return; }
    if (mode === 'schedule' && !scheduleAt) { setError('Pick a date and time.'); return; }
    setBusy(mode);
    try {
      const r = await api.compose({
        ...payloadBase(),
        draft: false,
        scheduledAt: mode === 'schedule' ? new Date(scheduleAt).toISOString() : null,
      });
      onSent({ threadId: r.threadId, scheduled: r.scheduled, draft: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send.');
      setBusy(null);
    }
  };

  const saveDraft = async () => {
    setBusy('draft');
    try {
      const r = await api.compose({ ...payloadBase(), draft: true });
      draftIdRef.current = r.messageId;
      onSent({ threadId: r.threadId, scheduled: false, draft: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save draft.');
      setBusy(null);
    }
  };

  const discard = async () => {
    if (draftIdRef.current) await api.deleteDraft(draftIdRef.current).catch(() => {});
    onClose();
  };

  const applyTemplate = (t: MailTemplate) => {
    if (!subject.trim()) setSubject(t.subject);
    setBody(t.bodyHtml + (signatureHtml ? `<p></p>${signatureHtml}` : ''));
    setShowTemplates(false);
  };

  const title = kind === 'reply' || kind === 'reply_all' ? 'Reply'
    : kind === 'forward' ? 'Forward' : 'New message';

  const shellClass = expanded
    ? 'inset-4 md:inset-10'
    : 'inset-x-2 bottom-0 top-16 sm:left-auto sm:right-6 sm:top-auto sm:h-[min(90vh,44rem)] sm:w-[min(42rem,calc(100vw-3rem))]';

  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className="fixed bottom-0 right-6 z-40 flex w-72 items-center justify-between rounded-t-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg"
      >
        <span className="truncate">{subject || title}</span>
        <Maximize2 size={14} />
      </button>
    );
  }

  return (
    <div className={`fixed z-40 ${shellClass}`}>
      <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border-light bg-white shadow-2xl dark:border-border-dark dark:bg-elevated-dark">
        <div className="flex items-center justify-between bg-blue-600 px-4 py-2 text-white">
          <span className="text-sm font-semibold">{title}</span>
          <div className="flex items-center gap-1">
            <IconButton label="Minimise" size="sm" className="text-white hover:bg-white/15" onClick={() => setMinimized(true)}>
              <Minus size={15} />
            </IconButton>
            <IconButton label={expanded ? 'Shrink' : 'Expand'} size="sm" className="text-white hover:bg-white/15" onClick={() => setExpanded((v) => !v)}>
              <Maximize2 size={14} />
            </IconButton>
            <IconButton label="Close" size="sm" className="text-white hover:bg-white/15" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
          <div className="flex items-center gap-2">
            <div className="flex-1"><RecipientInput label="To" values={to} onChange={setTo} autofocus={!seed?.to?.length} /></div>
            {!showCc && (
              <button className="shrink-0 text-xs text-text-secondary-light hover:underline dark:text-text-secondary-dark" onClick={() => setShowCc(true)}>
                Cc/Bcc
              </button>
            )}
          </div>
          {showCc && <RecipientInput label="Cc" values={cc} onChange={setCc} />}
          {showCc && <RecipientInput label="Bcc" values={bcc} onChange={setBcc} />}

          <div className="relative flex items-center border-b border-border-light dark:border-border-dark/60">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="flex-1 bg-transparent py-2.5 text-sm font-medium outline-none"
            />
            {aiAvailable && (
              <button
                type="button"
                title="Suggest a subject"
                onClick={async () => {
                  setSubjectBusy(true); setSubjectIdeas(null);
                  try { setSubjectIdeas((await api.aiSubject(htmlToPlain(bodyRef.current))).suggestions); }
                  catch { /* ignore */ }
                  finally { setSubjectBusy(false); }
                }}
                className="shrink-0 rounded-lg px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
              >
                {subjectBusy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              </button>
            )}
            {subjectIdeas && subjectIdeas.length > 0 && (
              <div className="absolute right-0 top-full z-10 mt-1 w-72 rounded-xl border border-border-light bg-white p-1 shadow-lg dark:border-border-dark dark:bg-elevated-dark">
                {subjectIdeas.map((s) => (
                  <button key={s} onClick={() => { setSubject(s); setSubjectIdeas(null); }}
                    className="block w-full rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-surface-light dark:hover:bg-surface-dark">{s}</button>
                ))}
              </div>
            )}
          </div>

          <div className="py-3">
            <RichTextEditor value={body} onChange={setBody} autofocus={!!seed?.to?.length} />
          </div>

          {attachments.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {attachments.map((a) => (
                <span key={a.fileId} className="inline-flex items-center gap-2 rounded-lg border border-border-light bg-surface-light px-2.5 py-1.5 text-xs dark:border-border-dark/60 dark:bg-surface-dark">
                  <Paperclip size={13} />
                  <span className="max-w-[10rem] truncate">{a.name}</span>
                  <span className="text-text-secondary-light dark:text-text-secondary-dark">{fmtSize(a.size)}</span>
                  <button aria-label="Remove attachment" onClick={() => setAttachments((x) => x.filter((y) => y.fileId !== a.fileId))}>
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">{error}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border-light px-4 py-2.5 dark:border-border-dark/60">
          <div className="relative flex items-center">
            <Button size="sm" onClick={() => doSend('send')} disabled={busy !== null}>
              {busy === 'send' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send
            </Button>
            <button
              aria-label="Send options"
              className="ml-px grid h-8 w-7 place-items-center rounded-full bg-blue-600 text-white hover:bg-blue-700"
              onClick={() => setShowSchedule((v) => !v)}
            >
              <ChevronDown size={14} />
            </button>
            {showSchedule && (
              <div className="absolute bottom-full left-0 z-10 mb-2 w-64 rounded-xl border border-border-light bg-white p-3 shadow-lg dark:border-border-dark dark:bg-elevated-dark">
                <p className="mb-2 text-xs font-medium">Schedule send</p>
                <input
                  type="datetime-local"
                  value={scheduleAt}
                  min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  className="mb-2 w-full rounded-lg border border-border-light bg-transparent px-2 py-1.5 text-sm dark:border-border-dark/60"
                />
                <Button size="sm" onClick={() => doSend('schedule')} disabled={busy !== null}>
                  <Clock size={13} /> Schedule
                </Button>
              </div>
            )}
          </div>

          {aiAvailable && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setAiOpen((v) => !v)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  aiOpen ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                    : 'border-border-light text-text-secondary-light hover:border-blue-400 hover:text-blue-600 dark:border-border-dark/60'
                }`}
              >
                <Sparkles size={14} /> AI
              </button>
              {aiOpen && (
                <AiAssistant
                  getCurrentHtml={() => bodyRef.current}
                  subject={subject}
                  recipients={[...to, ...cc].filter((t) => !t.startsWith('userId:'))}
                  threadId={seed?.threadId}
                  onApply={applyAi}
                  onClose={() => setAiOpen(false)}
                />
              )}
            </div>
          )}
          {undoBody !== null && (
            <IconButton label="Undo AI change" size="sm" onClick={() => { setBody(undoBody); setUndoBody(null); }}>
              <Undo2 size={16} />
            </IconButton>
          )}

          <IconButton label="Attach files" size="sm" onClick={() => fileRef.current?.click()}>
            {uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
          </IconButton>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />

          <div className="relative">
            <IconButton label="Insert template" size="sm" onClick={async () => {
              if (!templates) setTemplates(await api.listTemplates().catch(() => []));
              setShowTemplates((v) => !v);
            }}>
              <FileText size={16} />
            </IconButton>
            {showTemplates && templates && (
              <div className="absolute bottom-full left-0 z-10 mb-2 max-h-64 w-64 overflow-y-auto rounded-xl border border-border-light bg-white p-1 shadow-lg dark:border-border-dark dark:bg-elevated-dark">
                {templates.length === 0 && <p className="px-3 py-2 text-xs text-text-secondary-light">No templates yet.</p>}
                {templates.map((t) => (
                  <button key={t.id} onClick={() => applyTemplate(t)} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-light dark:hover:bg-surface-dark">
                    <span className="block font-medium">{t.name}</span>
                    <span className="block truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">{t.subject}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={saveDraft} disabled={busy !== null}>Save draft</Button>
            <IconButton label="Discard draft" size="sm" onClick={discard}><Trash2 size={16} /></IconButton>
          </div>
        </div>
      </div>
    </div>
  );
};
