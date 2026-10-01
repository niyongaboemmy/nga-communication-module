import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image as ImageIcon, BarChart3, CalendarDays, X, Loader2, Globe, ChevronDown,
  CalendarClock, Megaphone, GripVertical, Sparkles,
} from 'lucide-react';
import type {
  ComposePostPayload, FeedAudience, FeedMediaItem, FeedPageSummary, FeedPostView,
} from '@tupo/shared';
import { FEED_AUDIENCES, FEED_LIMITS } from '@tupo/shared';
import { Avatar } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { uploadFile, probeMedia, validateFile } from '../chat/uploads';
import { useMediaUrl, firstName, useDismiss } from './lib';
import * as api from './api';

interface PendingMedia {
  localId: string;
  kind: FeedMediaItem['kind'];
  name: string;
  previewUrl?: string;
  progress: number;
  fileId?: string;
  w?: number;
  h?: number;
  error?: string;
}

interface Props {
  pages: FeedPageSummary[];
  defaultPageId?: string;
  onPublished?: (post: FeedPostView | null) => void;
  /** When set, the composer edits an existing post instead of creating one. */
  editing?: FeedPostView;
  onClose?: () => void;
}

export const Composer: React.FC<Props> = ({ pages, defaultPageId, onPublished, editing, onClose }) => {
  const { user } = useAuth();
  const postable = useMemo(() => pages.filter((p) => p.canPost), [pages]);
  const [open, setOpen] = useState(Boolean(editing));
  const [pageId, setPageId] = useState(defaultPageId ?? editing?.page.id ?? postable[0]?.id ?? '');
  const [body, setBody] = useState(editing?.body ?? '');
  const [audience, setAudience] = useState<FeedAudience>(editing?.audience ?? 'everyone');
  const [media, setMedia] = useState<PendingMedia[]>(
    (editing?.media ?? []).map((m) => ({ localId: m.fileId, kind: m.kind, name: m.name ?? '', fileId: m.fileId, progress: 1, w: m.w ?? undefined, h: m.h ?? undefined })),
  );
  const [tool, setTool] = useState<'none' | 'poll' | 'event'>(editing?.poll ? 'poll' : editing?.event ? 'event' : 'none');
  const [pollOptions, setPollOptions] = useState<string[]>(editing?.poll?.options.map((o) => o.text) ?? ['', '']);
  const [pollQ, setPollQ] = useState(editing?.poll?.question ?? '');
  const [pollMulti, setPollMulti] = useState(editing?.poll?.multi ?? false);
  const [evt, setEvt] = useState({
    title: editing?.event?.title ?? '', startsAt: editing?.event?.startsAt?.slice(0, 16) ?? '', location: editing?.event?.location ?? '',
  });
  const [isAnnouncement, setIsAnnouncement] = useState(editing?.type === 'announcement');
  const [scheduleAt, setScheduleAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const dragFrom = useRef<number | null>(null);

  const page = pages.find((p) => p.id === pageId);

  // Pages load after mount, so adopt the first postable one once it arrives.
  useEffect(() => {
    if (!pageId && postable[0]) setPageId(postable[0].id);
  }, [pageId, postable]);

  useEffect(() => { if (open) bodyRef.current?.focus(); }, [open]);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [body, open]);

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, FEED_LIMITS.MAX_MEDIA - media.length);
    for (const file of list) {
      const invalid = validateFile(file);
      if (invalid) { setError(invalid); continue; }
      const localId = crypto.randomUUID();
      const probe = await probeMedia(file);
      const kind: FeedMediaItem['kind'] = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'document';
      setMedia((m) => [...m, { localId, kind, name: file.name, previewUrl: probe.previewUrl, progress: 0, w: probe.width, h: probe.height }]);
      const handle = uploadFile(file, (p) => setMedia((m) => m.map((x) => x.localId === localId ? { ...x, progress: p.fraction } : x)), probe);
      handle.promise
        .then((fileId) => setMedia((m) => m.map((x) => x.localId === localId ? { ...x, fileId, progress: 1 } : x)))
        .catch((e) => setMedia((m) => m.map((x) => x.localId === localId ? { ...x, error: String(e), progress: 0 } : x)));
    }
  };

  const canSubmit =
    Boolean(pageId) && !busy && !media.some((m) => !m.fileId && !m.error) &&
    (body.trim().length > 0 || media.some((m) => m.fileId) ||
      (tool === 'poll' && pollQ.trim() && pollOptions.filter((o) => o.trim()).length >= FEED_LIMITS.MIN_POLL_OPTIONS) ||
      (tool === 'event' && evt.title.trim() && evt.startsAt));

  const reset = () => {
    setBody(''); setMedia([]); setTool('none'); setPollOptions(['', '']); setPollQ('');
    setEvt({ title: '', startsAt: '', location: '' }); setIsAnnouncement(false); setScheduleAt(''); setOpen(false);
  };

  const submit = async (mode: 'published' | 'draft') => {
    if (!canSubmit) return;
    setBusy(true); setError(null);
    try {
      const validPoll = tool === 'poll' && pollQ.trim() && pollOptions.map((o) => o.trim()).filter(Boolean).length >= FEED_LIMITS.MIN_POLL_OPTIONS;
      // `datetime-local` gives a parseable string or '' — never garbage — but
      // an empty one must never reach `new Date().toISOString()` (throws) just
      // because the user opened the Event tool and typed body text instead of
      // filling it in. Same story for the schedule picker below.
      const eventDate = tool === 'event' && evt.startsAt ? new Date(evt.startsAt) : null;
      const validEvent = tool === 'event' && evt.title.trim() && eventDate && !Number.isNaN(eventDate.getTime());
      const scheduleDate = scheduleAt ? new Date(scheduleAt) : null;
      const validSchedule = scheduleDate && !Number.isNaN(scheduleDate.getTime());

      const payload: Omit<ComposePostPayload, 'pageId'> = {
        body: body.trim(),
        media: media.filter((m) => m.fileId).map((m) => ({ fileId: m.fileId!, kind: m.kind, name: m.name, w: m.w ?? null, h: m.h ?? null })),
        audience,
        type: isAnnouncement ? 'announcement' : 'standard',
        status: validSchedule ? 'scheduled' : mode,
        scheduledAt: validSchedule ? scheduleDate!.toISOString() : null,
      };
      // A half-filled poll/event the user abandoned in favour of plain text
      // must not be sent — an incomplete one would either 400 on the server
      // or (for the event's date) throw before this even reaches the network.
      if (validPoll) payload.poll = { question: pollQ.trim(), options: pollOptions.map((o) => o.trim()).filter(Boolean), multi: pollMulti };
      if (validEvent) payload.event = { title: evt.title.trim(), startsAt: eventDate!.toISOString(), location: evt.location.trim() || null };

      if (editing) {
        const updated = await api.editPost(editing.id, {
          body: payload.body, media: payload.media, audience: payload.audience,
        });
        onPublished?.(updated);
        onClose?.();
      } else {
        const { postId, status } = await api.createPost(pageId, payload);
        if (status === 'published') onPublished?.(await api.getPost(postId).catch(() => null));
        reset();
        onClose?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not publish.');
    } finally {
      setBusy(false);
    }
  };

  if (!postable.length && !editing) {
    return (
      <div className="feed-card p-4 text-center text-sm text-text-secondary-light dark:text-text-secondary-dark">
        You are not an editor of any page yet. Ask an admin to add you, or create a page from <span className="font-medium">Pages</span>.
      </div>
    );
  }

  if (!open) {
    return (
      <div className="feed-card px-3 pb-1.5 pt-3 sm:px-4">
        <div className="flex items-center gap-2.5">
          <Avatar name={user?.name ?? '?'} src={user?.avatarUrl} size={40} />
          <button
            onClick={() => setOpen(true)}
            className="flex-1 rounded-full bg-black/[0.05] px-4 py-2.5 text-left text-[15px] text-text-secondary-light transition-colors hover:bg-black/[0.08] dark:bg-white/5 dark:hover:bg-white/10"
          >
            {`What's on your mind${user?.name ? `, ${firstName(user.name)}` : ''}?`}
          </button>
        </div>
        <div className="mt-1.5 flex items-stretch border-t border-black/[0.08] pt-1 dark:border-white/[0.06]">
          <PillButton onClick={() => { fileInput.current?.click(); setOpen(true); }} icon={<ImageIcon size={20} className="text-emerald-500" />} label="Photo/video" />
          <PillButton onClick={() => { setTool('poll'); setOpen(true); }} icon={<BarChart3 size={20} className="text-purple-500" />} label="Poll" />
          <PillButton onClick={() => { setTool('event'); setOpen(true); }} icon={<CalendarDays size={20} className="text-orange-500" />} label="Event" />
        </div>
        <input ref={fileInput} type="file" hidden multiple accept="image/*,video/*,.pdf,.doc,.docx" onChange={(e) => e.target.files && addFiles(e.target.files)} />
      </div>
    );
  }

  const modal = (
    <div
      className="rounded-2xl border border-border-light bg-card-light shadow-xl dark:border-border-dark/40 dark:bg-elevated-dark"
      onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files); }}
      onDragOver={(e) => e.preventDefault()}
    >
      <div className="flex items-center justify-between border-b border-border-light px-4 py-3 dark:border-border-dark/40">
        <h2 className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">{editing ? 'Edit post' : 'Create post'}</h2>
        <button onClick={() => { reset(); onClose?.(); }} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-text-secondary-light hover:bg-surface-light dark:hover:bg-card-dark"><X size={18} /></button>
      </div>

      <div className="max-h-[70vh] overflow-y-auto p-4">
        {/* Post-as + audience */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <PagePicker pages={postable} value={pageId} onChange={setPageId} disabled={Boolean(editing)} />
          <label className="flex items-center gap-1.5 rounded-full border border-border-light px-2.5 py-1 text-xs font-medium text-text-secondary-light dark:border-border-dark/60 dark:text-text-secondary-dark">
            <Globe size={12} />
            <select value={audience} onChange={(e) => setAudience(e.target.value as FeedAudience)} className="bg-transparent outline-none">
              {FEED_AUDIENCES.map((a) => <option key={a} value={a} className="capitalize dark:bg-elevated-dark">{a[0]!.toUpperCase() + a.slice(1)}</option>)}
            </select>
          </label>
          {page?.myRole === 'owner' && (
            <button
              onClick={() => setIsAnnouncement((v) => !v)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                isAnnouncement ? 'border-blue-500 bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-300' : 'border-border-light text-text-secondary-light dark:border-border-dark/60 dark:text-text-secondary-dark'
              }`}
            >
              <Megaphone size={12} /> Announcement
            </button>
          )}
        </div>

        <textarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What would you like to share?"
          className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-text-primary-light outline-none placeholder:text-text-secondary-light/70 dark:text-text-primary-dark"
          rows={3}
        />

        {media.length > 0 && (
          <div className="mt-2 grid grid-cols-3 gap-2">
            {media.map((m, i) => (
              <div
                key={m.localId}
                draggable
                onDragStart={() => { dragFrom.current = i; }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  const from = dragFrom.current;
                  if (from === null || from === i) return;
                  setMedia((arr) => { const next = [...arr]; const [x] = next.splice(from, 1); next.splice(i, 0, x!); return next; });
                  dragFrom.current = null;
                }}
                className="group relative aspect-square overflow-hidden rounded-lg border border-border-light bg-surface-light dark:border-border-dark/50 dark:bg-card-dark"
              >
                {m.previewUrl && m.kind === 'image' && <img src={m.previewUrl} alt="" className="h-full w-full object-cover" />}
                {m.previewUrl && m.kind === 'video' && <video src={m.previewUrl} className="h-full w-full object-cover" muted />}
                {!m.previewUrl && <div className="grid h-full place-items-center text-[10px] text-text-secondary-light">{m.name}</div>}
                {m.progress < 1 && !m.error && (
                  <div className="absolute inset-0 grid place-items-center bg-black/40"><Loader2 size={18} className="animate-spin text-white" /></div>
                )}
                {m.error && <div className="absolute inset-0 grid place-items-center bg-red-600/70 p-1 text-center text-[10px] text-white">Upload failed</div>}
                <span className="absolute left-1 top-1 rounded bg-black/50 p-0.5 text-white opacity-0 group-hover:opacity-100"><GripVertical size={11} /></span>
                <button onClick={() => setMedia((arr) => arr.filter((x) => x.localId !== m.localId))} aria-label="Remove" className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-white"><X size={11} /></button>
              </div>
            ))}
          </div>
        )}

        {tool === 'poll' && (
          <div className="mt-3 rounded-xl border border-border-light p-3 dark:border-border-dark/50">
            <input value={pollQ} onChange={(e) => setPollQ(e.target.value)} placeholder="Ask a question…" className="w-full bg-transparent text-sm font-medium outline-none" />
            <div className="mt-2 space-y-1.5">
              {pollOptions.map((o, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={o} onChange={(e) => setPollOptions((p) => p.map((x, j) => j === i ? e.target.value : x))}
                    placeholder={`Option ${i + 1}`} className="flex-1 rounded-lg border border-border-light bg-surface-light px-2.5 py-1.5 text-sm outline-none dark:border-border-dark/60 dark:bg-card-dark/50" />
                  {pollOptions.length > 2 && <button onClick={() => setPollOptions((p) => p.filter((_, j) => j !== i))} aria-label="Remove option"><X size={14} /></button>}
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between text-xs">
              {pollOptions.length < FEED_LIMITS.MAX_POLL_OPTIONS
                ? <button onClick={() => setPollOptions((p) => [...p, ''])} className="font-semibold text-blue-600 dark:text-blue-400">+ Add option</button>
                : <span />}
              <label className="flex items-center gap-1.5 text-text-secondary-light dark:text-text-secondary-dark">
                <input type="checkbox" checked={pollMulti} onChange={(e) => setPollMulti(e.target.checked)} /> Allow multiple
              </label>
            </div>
          </div>
        )}

        {tool === 'event' && (
          <div className="mt-3 space-y-2 rounded-xl border border-border-light p-3 dark:border-border-dark/50">
            <input value={evt.title} onChange={(e) => setEvt({ ...evt, title: e.target.value })} placeholder="Event name" className="w-full rounded-lg border border-border-light bg-surface-light px-2.5 py-1.5 text-sm outline-none dark:border-border-dark/60 dark:bg-card-dark/50" />
            <input type="datetime-local" value={evt.startsAt} onChange={(e) => setEvt({ ...evt, startsAt: e.target.value })} className="w-full rounded-lg border border-border-light bg-surface-light px-2.5 py-1.5 text-sm outline-none dark:border-border-dark/60 dark:bg-card-dark/50" />
            <input value={evt.location} onChange={(e) => setEvt({ ...evt, location: e.target.value })} placeholder="Location (optional)" className="w-full rounded-lg border border-border-light bg-surface-light px-2.5 py-1.5 text-sm outline-none dark:border-border-dark/60 dark:bg-card-dark/50" />
          </div>
        )}

        {scheduleAt && (
          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400">
            <CalendarClock size={13} /> Scheduled for {new Date(scheduleAt).toLocaleString()}
            <button onClick={() => setScheduleAt('')} className="underline">clear</button>
          </p>
        )}
        {error && <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{error}</p>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-light px-4 py-3 dark:border-border-dark/40">
        <div className="flex items-center gap-1">
          <ToolBtn active={media.length > 0} onClick={() => fileInput.current?.click()} icon={<ImageIcon size={18} className="text-emerald-500" />} label="Photo/video" />
          <ToolBtn active={tool === 'poll'} onClick={() => setTool((t) => t === 'poll' ? 'none' : 'poll')} icon={<BarChart3 size={18} className="text-purple-500" />} label="Poll" />
          <ToolBtn active={tool === 'event'} onClick={() => setTool((t) => t === 'event' ? 'none' : 'event')} icon={<CalendarDays size={18} className="text-orange-500" />} label="Event" />
          {!editing && (
            <label className="grid h-9 w-9 cursor-pointer place-items-center rounded-full text-blue-500 hover:bg-surface-light dark:hover:bg-card-dark" title="Schedule">
              <CalendarClock size={18} />
              <input type="datetime-local" hidden onChange={(e) => setScheduleAt(e.target.value)} />
            </label>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!editing && (
            <button onClick={() => void submit('draft')} disabled={!canSubmit} className="rounded-full px-3 py-1.5 text-sm font-semibold text-text-secondary-light hover:bg-surface-light disabled:opacity-40 dark:text-text-secondary-dark dark:hover:bg-card-dark">
              Save draft
            </button>
          )}
          <button onClick={() => void submit('published')} disabled={!canSubmit} data-track={editing ? undefined : 'tupo.feed.publish_click'}
            className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-5 py-1.5 text-sm font-semibold text-white transition-opacity hover:bg-blue-700 disabled:opacity-40">
            {busy && <Loader2 size={14} className="animate-spin" />}
            {editing ? 'Save' : scheduleAt ? 'Schedule' : 'Post'}
          </button>
        </div>
      </div>
      <input ref={fileInput} type="file" hidden multiple accept="image/*,video/*,.pdf,.doc,.docx" onChange={(e) => e.target.files && addFiles(e.target.files)} />
    </div>
  );

  if (editing) {
    return (
      <div className="fixed inset-0 z-[90] grid place-items-center bg-black/50 p-4" onClick={() => onClose?.()}>
        <div className="w-full max-w-xl animate-pop" onClick={(e) => e.stopPropagation()}>{modal}</div>
      </div>
    );
  }
  return <div className="animate-pop">{modal}</div>;
};

const PillButton: React.FC<{ onClick: () => void; icon: React.ReactNode; label: string }> = ({ onClick, icon, label }) => (
  <button onClick={onClick} className="feed-act flex flex-1 items-center justify-center gap-2 rounded-md py-2 text-[13px] font-semibold text-[#65676b] transition-colors sm:text-[15px] dark:text-text-secondary-dark">
    {icon} <span>{label}</span>
  </button>
);

const ToolBtn: React.FC<{ active: boolean; onClick: () => void; icon: React.ReactNode; label: string }> = ({ active, onClick, icon, label }) => (
  <button onClick={onClick} title={label} aria-label={label}
    className={`grid h-9 w-9 place-items-center rounded-full transition-colors ${active ? 'bg-surface-light dark:bg-card-dark' : 'hover:bg-surface-light dark:hover:bg-card-dark'}`}>
    {icon}
  </button>
);

const PagePicker: React.FC<{ pages: FeedPageSummary[]; value: string; onChange: (id: string) => void; disabled?: boolean }> = ({ pages, value, onChange, disabled }) => {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const current = pages.find((p) => p.id === value);
  const avatarUrl = useMediaUrl(current?.avatarFileId);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => !disabled && setOpen((v) => !v)} disabled={disabled} aria-haspopup="listbox" aria-expanded={open}
        className="flex items-center gap-2 rounded-full border border-border-light py-1 pl-1 pr-2.5 text-sm font-semibold text-text-primary-light disabled:opacity-70 dark:border-border-dark/60 dark:text-text-primary-dark">
        <Avatar name={current?.name ?? '?'} src={avatarUrl} size={24} />
        {current?.name ?? 'Choose a page'}
        {!disabled && <ChevronDown size={14} />}
      </button>
      {open && (
        <div role="listbox" className="animate-pop absolute left-0 top-full z-30 mt-1 max-h-60 w-56 overflow-y-auto rounded-xl border border-border-light bg-white p-1 shadow-xl dark:border-border-dark/60 dark:bg-elevated-dark">
          {pages.map((p) => (
            <button key={p.id} onClick={() => { onChange(p.id); setOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-light dark:hover:bg-card-dark">
              <Avatar name={p.name} size={22} /> <span className="truncate">{p.name}</span>
              {p.myRole === 'owner' && <Sparkles size={11} className="ml-auto text-amber-500" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
