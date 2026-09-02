import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft, Reply, ReplyAll, Forward, Archive, Trash2, Star, Tag, MoreVertical,
  Paperclip, Download, ChevronDown, ChevronRight, BarChart3, Clock, X, Send, Edit3, Loader2,
  Sparkles, ListChecks, CheckCircle2,
} from 'lucide-react';
import type { MailAiThreadSummary } from '@tupo/shared';
import { Avatar, IconButton, Spinner, EmptyState, Button } from '../../components/ui';
import { apiDownload } from '../../lib/api';
import { replySubject, forwardSubject } from './replyHelpers';
import { RichTextEditor } from './RichTextEditor';
import { DeliverySheet } from './DeliverySheet';
import * as api from './api';
import type { MailThreadView, MailMessageView, MailLabel, MailMessageKind } from '@tupo/shared';
import type { ComposerSeed } from './Composer';

interface Props {
  threadId: string;
  labels: MailLabel[];
  myUserId: string;
  onBack: () => void;
  onChanged: () => void;
  onCompose: (seed: ComposerSeed) => void;
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1e6 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1e6).toFixed(1)} MB`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const AttachmentChip: React.FC<{ a: MailMessageView['attachments'][number] }> = ({ a }) => (
  <button
    onClick={() => apiDownload(`/api/files/${a.fileId}/content`, a.name)}
    className="inline-flex items-center gap-2 rounded-lg border border-border-light bg-surface-light px-3 py-2 text-xs hover:border-blue-400 dark:border-border-dark/60 dark:bg-surface-dark"
  >
    <Paperclip size={13} />
    <span className="max-w-[12rem] truncate font-medium">{a.name}</span>
    <span className="text-text-secondary-light dark:text-text-secondary-dark">{fmtSize(a.size)}</span>
    <Download size={13} className="text-blue-600" />
  </button>
);

const InlineReply: React.FC<{
  message: MailMessageView; kind: MailMessageKind; initialBody?: string; onDone: () => void; onCancel: () => void;
}> = ({ message, kind, initialBody, onDone, onCancel }) => {
  const [body, setBody] = useState(initialBody ? `<p>${initialBody}</p>` : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true); setError(null);
    try {
      const to = kind === 'reply' ? [recip(message.from)]
        : [recip(message.from), ...message.to.map(recip), ...message.cc.map(recip)];
      await api.compose({
        to: [...new Set(to)], subject: replySubject(message.subject),
        bodyHtml: body, threadId: message.threadId, parentId: message.id, kind,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send.'); setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border-light p-3 dark:border-border-dark/60">
      <RichTextEditor value={body} onChange={setBody} minimal autofocus placeholder="Type your reply…" />
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" onClick={send} disabled={busy}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
};

const recip = (p: { userId: string | null; address: string }) => (p.userId ? `userId:${p.userId}` : p.address);

const MessageCard: React.FC<{
  message: MailMessageView; myUserId: string; expanded: boolean; onToggle: () => void;
  onReply: (k: MailMessageKind) => void; onDelivery: () => void; onEditDraft: () => void; onChanged: () => void;
}> = ({ message, myUserId, expanded, onToggle, onReply, onDelivery, onEditDraft, onChanged }) => {
  const isMine = message.from.userId === myUserId;
  const ds = message.deliverySummary;

  return (
    <div className="rounded-xl border border-border-light dark:border-border-dark/50">
      <button onClick={onToggle} className="flex w-full items-start gap-3 p-3 text-left">
        <Avatar name={message.from.name} src={message.from.avatarUrl ?? undefined} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{message.from.name}</span>
            {message.isDraft && <span className="rounded bg-amber-100 px-1.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">Draft</span>}
            {message.scheduledAt && !message.sentAt && <span className="inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 text-[10px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"><Clock size={10} /> {when(message.scheduledAt)}</span>}
            <span className="ml-auto shrink-0 text-xs text-text-secondary-light dark:text-text-secondary-dark">{when(message.sentAt ?? message.createdAt)}</span>
          </div>
          {expanded ? (
            <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
              to {message.to.map((p) => p.name).join(', ') || 'me'}
              {message.cc.length > 0 && <>, cc {message.cc.map((p) => p.name).join(', ')}</>}
            </p>
          ) : (
            <p className="truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">{message.snippet}</p>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3">
          <div
            className="tupo-prose max-w-none border-t border-border-light pt-3 dark:border-border-dark/40"
            dangerouslySetInnerHTML={{ __html: message.bodyHtml || '<p class="text-text-secondary-light">(no content)</p>' }}
          />

          {message.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {message.attachments.map((a) => <AttachmentChip key={a.id} a={a} />)}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {message.isDraft ? (
              <Button size="sm" onClick={onEditDraft}><Edit3 size={14} /> Continue editing</Button>
            ) : message.scheduledAt && !message.sentAt ? (
              <Button size="sm" variant="secondary" onClick={() => api.cancelScheduled(message.id).then(onChanged)}>
                <X size={14} /> Cancel scheduled send
              </Button>
            ) : (
              <>
                <Button size="sm" variant="secondary" onClick={() => onReply('reply')}><Reply size={14} /> Reply</Button>
                {(message.to.length + message.cc.length > 0) && (
                  <Button size="sm" variant="secondary" onClick={() => onReply('reply_all')}><ReplyAll size={14} /> Reply all</Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => onReply('forward')}><Forward size={14} /> Forward</Button>
              </>
            )}
            {isMine && ds && (
              <button onClick={onDelivery} className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border-light px-2.5 py-1 text-xs dark:border-border-dark/60">
                <BarChart3 size={13} />
                {ds.delivered}/{ds.total} delivered
                {ds.bounced + ds.failed > 0 && <span className="text-red-600">· {ds.bounced + ds.failed} failed</span>}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export const ThreadView: React.FC<Props> = ({ threadId, labels, myUserId, onBack, onChanged, onCompose }) => {
  const [thread, setThread] = useState<MailThreadView | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [replyTo, setReplyTo] = useState<{ id: string; kind: MailMessageKind; initialBody?: string } | null>(null);
  const [delivery, setDelivery] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [summary, setSummary] = useState<MailAiThreadSummary | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [smartReplies, setSmartReplies] = useState<Array<{ intent: string; text: string }> | null>(null);
  const [repliesBusy, setRepliesBusy] = useState(false);

  useEffect(() => { api.aiStatus().then(setAiAvailable).catch(() => setAiAvailable(false)); }, []);
  useEffect(() => { setSummary(null); setSmartReplies(null); }, [threadId]);

  const runSummary = async () => {
    setSummaryBusy(true);
    try { setSummary(await api.aiSummarize(threadId)); } catch { /* ignore */ } finally { setSummaryBusy(false); }
  };
  const runSmartReplies = async () => {
    setRepliesBusy(true);
    try { setSmartReplies((await api.aiSmartReplies(threadId)).replies); } catch { /* ignore */ } finally { setRepliesBusy(false); }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const t = await api.getThread(threadId);
      setThread(t);
      // Expand the last message, plus any draft.
      const last = t.messages[t.messages.length - 1];
      setExpanded(new Set(t.messages.filter((m) => m.isDraft || m.id === last?.id).map((m) => m.id)));
    } catch {
      setThread(null);
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="grid h-full place-items-center"><Spinner /></div>;
  if (!thread) return <EmptyState title="Thread not found" hint="It may have been deleted." />;

  const currentLabels = thread.labels;
  const toggleLabel = async (id: string) => {
    const next = currentLabels.includes(id) ? currentLabels.filter((x) => x !== id) : [...currentLabels, id];
    await api.setThreadLabels(threadId, next).catch(() => {});
    load(); onChanged();
  };

  const doReply = (messageId: string, kind: MailMessageKind) => {
    const m = thread.messages.find((x) => x.id === messageId)!;
    if (kind === 'forward') {
      onCompose({
        subject: forwardSubject(m.subject),
        bodyHtml: `<p></p><p></p><blockquote>---------- Forwarded message ----------<br>From: ${m.from.name} &lt;${m.from.address}&gt;<br>Subject: ${m.subject}</blockquote>${m.bodyHtml}`,
        kind: 'forward',
      });
      return;
    }
    setReplyTo({ id: messageId, kind });
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border-light px-2 py-2 dark:border-border-dark/50">
        <IconButton label="Back" size="sm" onClick={onBack}><ArrowLeft size={17} /></IconButton>
        <h2 className="truncate px-1 text-sm font-semibold">{thread.subject}</h2>
        <div className="ml-auto flex items-center gap-0.5">
          <div className="relative">
            <IconButton label="Labels" size="sm" onClick={() => setShowLabels((v) => !v)}><Tag size={16} /></IconButton>
            {showLabels && (
              <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-xl border border-border-light bg-white p-1 shadow-lg dark:border-border-dark dark:bg-elevated-dark">
                {labels.map((l) => (
                  <button key={l.id} onClick={() => toggleLabel(l.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-light dark:hover:bg-surface-dark">
                    <input type="checkbox" readOnly checked={currentLabels.includes(l.id)} className="accent-blue-600" />
                    <Tag size={13} style={{ color: l.color }} /> {l.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          {aiAvailable && thread.messages.length > 0 && (
            <IconButton label="Summarise with AI" size="sm" active={!!summary} onClick={summary ? () => setSummary(null) : runSummary}>
              {summaryBusy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={16} />}
            </IconButton>
          )}
          <IconButton label="Archive" size="sm" onClick={() => { api.moveThread(threadId, 'archive').then(() => { onBack(); onChanged(); }); }}><Archive size={16} /></IconButton>
          <IconButton label="Delete" size="sm" onClick={() => { api.moveThread(threadId, 'trash').then(() => { onBack(); onChanged(); }); }}><Trash2 size={16} /></IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {summary && (
          <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-sm dark:border-blue-900/50 dark:bg-blue-900/15">
            <div className="mb-1.5 flex items-center gap-1.5 text-blue-700 dark:text-blue-300">
              <Sparkles size={14} />
              <span className="text-xs font-semibold uppercase tracking-wide">Thread summary</span>
              <span className="ml-auto text-[10px] font-normal opacity-70">via {summary.providerUsed}</span>
            </div>
            <p className="text-text-primary-light dark:text-text-primary-dark">{summary.summary}</p>
            {summary.keyPoints.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                {summary.keyPoints.map((k, i) => <li key={i}>{k}</li>)}
              </ul>
            )}
            {summary.actionItems.length > 0 && (
              <div className="mt-2">
                <p className="flex items-center gap-1 text-xs font-semibold"><ListChecks size={13} /> Action items</p>
                <ul className="mt-1 space-y-1">
                  {summary.actionItems.map((a, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs">
                      <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-500" />
                      <span>{a.text}{a.owner && <span className="text-text-secondary-light"> — {a.owner}</span>}{a.due && <span className="text-text-secondary-light"> ({a.due})</span>}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {summary.needsReply && <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">This thread looks like it still needs a reply from you.</p>}
          </div>
        )}
        {currentLabels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {currentLabels.map((id) => {
              const l = labels.find((x) => x.id === id);
              return l ? (
                <span key={id} className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs" style={{ background: `${l.color}22`, color: l.color }}>
                  {l.name}
                  <button onClick={() => toggleLabel(id)} aria-label={`Remove ${l.name}`}><X size={11} /></button>
                </span>
              ) : null;
            })}
          </div>
        )}

        {thread.messages.map((m) => (
          <React.Fragment key={m.id}>
            <MessageCard
              message={m}
              myUserId={myUserId}
              expanded={expanded.has(m.id)}
              onToggle={() => setExpanded((s) => { const n = new Set(s); n.has(m.id) ? n.delete(m.id) : n.add(m.id); return n; })}
              onReply={(k) => doReply(m.id, k)}
              onDelivery={() => setDelivery(m.id)}
              onEditDraft={() => onCompose({ draftId: m.id, subject: m.subject, bodyHtml: m.bodyHtml, threadId: m.threadId })}
              onChanged={() => { load(); onChanged(); }}
            />
            {replyTo?.id === m.id && (
              <InlineReply
                message={m}
                kind={replyTo.kind}
                initialBody={replyTo.initialBody}
                onDone={() => { setReplyTo(null); setSmartReplies(null); load(); onChanged(); }}
                onCancel={() => setReplyTo(null)}
              />
            )}
          </React.Fragment>
        ))}

        {aiAvailable && !replyTo && (() => {
          const last = thread.messages.filter((m) => !m.isDraft).slice(-1)[0];
          if (!last || last.from.userId === myUserId) return null;
          return (
            <div className="rounded-xl border border-border-light p-2.5 dark:border-border-dark/50">
              {!smartReplies ? (
                <button onClick={runSmartReplies} disabled={repliesBusy}
                  className="inline-flex items-center gap-1.5 text-sm text-blue-600">
                  {repliesBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Suggest replies
                </button>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {smartReplies.map((r, i) => (
                    <button key={i} title={r.text}
                      onClick={() => setReplyTo({ id: last.id, kind: last.to.length + last.cc.length > 0 ? 'reply_all' : 'reply', initialBody: r.text })}
                      className="max-w-full truncate rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs text-blue-700 hover:bg-blue-100 dark:border-blue-900/50 dark:bg-blue-900/20 dark:text-blue-300">
                      <span className="font-medium">{r.intent}:</span> {r.text}
                    </button>
                  ))}
                  <button onClick={() => setSmartReplies(null)} className="text-xs text-text-secondary-light">clear</button>
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {delivery && <DeliverySheet messageId={delivery} onClose={() => setDelivery(null)} />}
    </div>
  );
};
