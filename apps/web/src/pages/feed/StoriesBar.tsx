import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X, Loader2, Eye, Trash2, Image as ImageIcon, Type } from 'lucide-react';
import type { FeedMediaItem, FeedStoryGroup, FeedStoryView, FeedStoryViewer } from '@tupo/shared';
import { FEED_LIMITS } from '@tupo/shared';
import { Avatar } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { uploadFile, probeMedia, validateFile } from '../chat/uploads';
import { useMediaUrl, firstName, relativeTime } from './lib';
import * as api from './api';

/**
 * The real "Stories" bar (FR-FEED-14) — 24-hour statuses grouped by author,
 * distinct from HighlightsBar's academic announcements/events strip. Sits
 * above it on the home feed.
 */

const BACKGROUNDS = [
  'linear-gradient(135deg,#2563eb,#7c3aed)',
  'linear-gradient(135deg,#db2777,#f97316)',
  'linear-gradient(135deg,#059669,#0ea5e9)',
  'linear-gradient(135deg,#d97706,#dc2626)',
  'linear-gradient(135deg,#4f46e5,#0891b2)',
];

export const StoriesBar: React.FC = () => {
  const { user } = useAuth();
  const [groups, setGroups] = useState<FeedStoryGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [viewerAt, setViewerAt] = useState<number | null>(null);

  const reload = useCallback(() => {
    api.getStoryGroups().then((g) => { setGroups(g); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const mine = user ? groups.find((g) => g.author.id === user.id) : undefined;

  if (!loaded) return null;

  return (
    <div className="feed-hl-scroll -mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
      <button onClick={() => setComposerOpen(true)} className="feed-card-in group relative h-40 w-28 shrink-0 overflow-hidden rounded-2xl border border-border-light bg-card-light text-left dark:border-border-dark/40 dark:bg-elevated-dark">
        <div className="grid h-28 w-full place-items-center overflow-hidden bg-surface-light dark:bg-card-dark">
          <Avatar name={user?.name ?? '?'} src={user?.avatarUrl} size={72} />
        </div>
        <span className="absolute left-1/2 top-24 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full border-4 border-card-light bg-blue-600 text-white dark:border-elevated-dark">
          <Plus size={16} />
        </span>
        <span className="absolute inset-x-0 bottom-0 h-12 bg-card-light px-1.5 pt-4 text-center text-xs font-semibold text-text-primary-light dark:bg-elevated-dark dark:text-text-primary-dark">
          {mine ? 'Add to story' : 'Create story'}
        </span>
      </button>

      {groups.filter((g) => g.author.id !== user?.id).map((g) => (
        <StoryThumb key={g.author.id} group={g} onOpen={() => setViewerAt(groups.indexOf(g))} />
      ))}
      {mine && (
        <StoryThumb group={mine} isMine onOpen={() => setViewerAt(groups.indexOf(mine))} />
      )}

      {composerOpen && <StoryComposer onClose={() => setComposerOpen(false)} onPosted={() => { setComposerOpen(false); reload(); }} />}
      {viewerAt !== null && groups[viewerAt] && (
        <StoryViewer
          groups={groups}
          startAt={viewerAt}
          onClose={() => setViewerAt(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
};

const StoryThumb: React.FC<{ group: FeedStoryGroup; isMine?: boolean; onOpen: () => void }> = ({ group, isMine, onOpen }) => {
  const cover = group.stories[group.stories.length - 1];
  const coverMediaUrl = useMediaUrl(cover?.media?.fileId);
  return (
    <button onClick={onOpen} className="feed-card-in group relative h-40 w-28 shrink-0 overflow-hidden rounded-2xl text-left text-white">
      {coverMediaUrl && cover?.media?.kind === 'image'
        ? <img src={coverMediaUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        : coverMediaUrl && cover?.media?.kind === 'video'
          ? <video src={coverMediaUrl} className="absolute inset-0 h-full w-full object-cover" muted />
          : <div className="absolute inset-0" style={{ background: cover?.background || BACKGROUNDS[0] }} />}
      <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/5 to-black/10" />
      <span className={`absolute left-2 top-2 grid h-9 w-9 place-items-center rounded-full ring-[3px] ${group.allViewed ? 'ring-black/20' : 'ring-blue-500'}`}>
        <Avatar name={group.author.name} src={group.author.avatarUrl ?? undefined} size={32} />
      </span>
      {cover?.caption && !cover.media && (
        <span className="absolute inset-x-2 top-1/2 -translate-y-1/2 line-clamp-4 text-center text-[11px] font-bold leading-tight">{cover.caption}</span>
      )}
      <span className="absolute inset-x-1.5 bottom-1.5 line-clamp-2 text-[11px] font-semibold">
        {isMine ? 'Your story' : firstName(group.author.name)}
      </span>
    </button>
  );
};

/* ── Composer ─────────────────────────────────────────────────────────── */

const StoryComposer: React.FC<{ onClose: () => void; onPosted: () => void }> = ({ onClose, onPosted }) => {
  const [mode, setMode] = useState<'text' | 'media'>('text');
  const [caption, setCaption] = useState('');
  const [background, setBackground] = useState(BACKGROUNDS[0]!);
  const [media, setMedia] = useState<{ fileId?: string; kind: FeedMediaItem['kind']; previewUrl?: string; progress: number; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFile = async (file: File) => {
    const invalid = validateFile(file);
    if (invalid) { setError(invalid); return; }
    const probe = await probeMedia(file);
    const kind: FeedMediaItem['kind'] = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'document';
    if (kind === 'document') { setError('A story needs a photo or a video.'); return; }
    setMode('media');
    setMedia({ kind, previewUrl: probe.previewUrl, progress: 0 });
    const handle = uploadFile(file, (p) => setMedia((m) => m && { ...m, progress: p.fraction }), probe);
    handle.promise
      .then((fileId) => setMedia((m) => m && { ...m, fileId, progress: 1 }))
      .catch((e) => setMedia((m) => m && { ...m, error: String(e), progress: 0 }));
  };

  const canSubmit = !busy && (mode === 'text' ? caption.trim().length > 0 : Boolean(media?.fileId));

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setError(null);
    try {
      await api.createStory({
        caption: caption.trim(),
        background: mode === 'text' ? background : '',
        media: mode === 'media' && media?.fileId ? { fileId: media.fileId, kind: media.kind } : null,
      });
      onPosted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post your story.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-sm animate-pop overflow-hidden rounded-2xl bg-card-light dark:bg-elevated-dark" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border-light px-4 py-3 dark:border-border-dark/40">
          <h2 className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">Create story</h2>
          <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full hover:bg-surface-light dark:hover:bg-card-dark"><X size={18} /></button>
        </div>

        <div
          className="relative flex h-72 items-center justify-center overflow-hidden p-4 text-center text-white"
          style={mode === 'text' ? { background } : undefined}
        >
          {mode === 'media' && media?.previewUrl && media.kind === 'image' && <img src={media.previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />}
          {mode === 'media' && media?.previewUrl && media.kind === 'video' && <video src={media.previewUrl} className="absolute inset-0 h-full w-full object-cover" muted autoPlay loop />}
          {mode === 'media' && media && media.progress < 1 && !media.error && (
            <div className="absolute inset-0 grid place-items-center bg-black/40"><Loader2 className="animate-spin" /></div>
          )}
          {mode === 'text' && (
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value.slice(0, FEED_LIMITS.STORY_CAPTION_MAX))}
              placeholder="What's on your mind?"
              className="relative z-10 w-full resize-none bg-transparent text-center text-xl font-bold leading-snug text-white placeholder:text-white/70 outline-none"
              rows={4}
              autoFocus
            />
          )}
        </div>

        {mode === 'text' && (
          <div className="flex items-center justify-center gap-2 border-b border-border-light px-4 py-2.5 dark:border-border-dark/40">
            {BACKGROUNDS.map((bg) => (
              <button key={bg} onClick={() => setBackground(bg)} aria-label="Choose background"
                className={`h-6 w-6 rounded-full ring-2 transition-all ${background === bg ? 'ring-blue-500 scale-110' : 'ring-transparent'}`}
                style={{ background: bg }} />
            ))}
          </div>
        )}

        {mode === 'media' && (
          <div className="border-b border-border-light px-4 py-2 dark:border-border-dark/40">
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value.slice(0, FEED_LIMITS.STORY_CAPTION_MAX))}
              placeholder="Add a caption…"
              className="w-full bg-transparent text-sm outline-none"
            />
          </div>
        )}

        {error && <p className="px-4 pt-2 text-xs font-medium text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <div className="flex items-center gap-1">
            <button onClick={() => fileInput.current?.click()} title="Photo/video" className="grid h-9 w-9 place-items-center rounded-full text-emerald-500 hover:bg-surface-light dark:hover:bg-card-dark">
              <ImageIcon size={18} />
            </button>
            {mode === 'media' && (
              <button onClick={() => { setMode('text'); setMedia(null); }} title="Text status" className="grid h-9 w-9 place-items-center rounded-full text-blue-500 hover:bg-surface-light dark:hover:bg-card-dark">
                <Type size={18} />
              </button>
            )}
          </div>
          <button onClick={() => void submit()} disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-5 py-1.5 text-sm font-semibold text-white disabled:opacity-40">
            {busy && <Loader2 size={14} className="animate-spin" />} Share to story
          </button>
        </div>
        <input ref={fileInput} type="file" hidden accept="image/*,video/*" onChange={(e) => e.target.files?.[0] && void addFile(e.target.files[0])} />
      </div>
    </div>
  );
};

/* ── Viewer ───────────────────────────────────────────────────────────── */

const STORY_DURATION_MS = 5000;

const StoryViewer: React.FC<{ groups: FeedStoryGroup[]; startAt: number; onClose: () => void; onChanged: () => void }> = ({
  groups, startAt, onClose, onChanged,
}) => {
  const { user } = useAuth();
  const [groupIdx, setGroupIdx] = useState(startAt);
  const [storyIdx, setStoryIdx] = useState(() => Math.max(0, groups[startAt]!.stories.findIndex((s) => !s.viewed)));
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewers, setViewers] = useState<FeedStoryViewer[] | null>(null);
  const seenRef = useRef(new Set<string>());
  const rafRef = useRef<number | undefined>(undefined);
  const startRef = useRef(0);

  const group = groups[groupIdx];
  const story = group?.stories[storyIdx];
  const isMine = story?.author.id === user?.id;
  const mediaUrl = useMediaUrl(story?.media?.fileId);

  const advance = useCallback((dir: 1 | -1) => {
    setViewers(null);
    if (!group) return;
    const nextStoryIdx = storyIdx + dir;
    if (nextStoryIdx >= 0 && nextStoryIdx < group.stories.length) {
      setStoryIdx(nextStoryIdx);
      return;
    }
    const nextGroupIdx = groupIdx + dir;
    if (nextGroupIdx >= 0 && nextGroupIdx < groups.length) {
      setGroupIdx(nextGroupIdx);
      setStoryIdx(dir === 1 ? 0 : groups[nextGroupIdx]!.stories.length - 1);
      return;
    }
    onClose();
  }, [group, groupIdx, storyIdx, groups, onClose]);

  useEffect(() => {
    setProgress(0);
    if (!story) return;
    if (!seenRef.current.has(story.id)) {
      seenRef.current.add(story.id);
      void api.recordStoryView(story.id);
    }
  }, [story?.id]);

  useEffect(() => {
    if (paused || !story) return;
    startRef.current = performance.now() - progress * STORY_DURATION_MS;
    const tick = () => {
      const elapsed = performance.now() - startRef.current;
      const frac = Math.min(1, elapsed / STORY_DURATION_MS);
      setProgress(frac);
      if (frac >= 1) { advance(1); return; }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id, paused]);

  const openViewers = () => {
    if (!story) return;
    setPaused(true);
    api.getStoryViewers(story.id).then(setViewers).catch(() => setViewers([]));
  };

  const remove = async () => {
    if (!story) return;
    await api.deleteStory(story.id).catch(() => {});
    onChanged();
    advance(1);
  };

  if (!group || !story) return null;

  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-black/90 p-2 sm:p-6" onClick={onClose}>
      <div className="relative flex h-full max-h-[860px] w-full max-w-[420px] flex-col overflow-hidden rounded-2xl bg-black text-white" onClick={(e) => e.stopPropagation()}>
        <div className="absolute inset-x-2 top-2 z-20 flex gap-1">
          {group.stories.map((s, i) => (
            <div key={s.id} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/30">
              <div className="h-full bg-white transition-[width] duration-100 linear"
                style={{ width: i < storyIdx ? '100%' : i === storyIdx ? `${progress * 100}%` : '0%' }} />
            </div>
          ))}
        </div>

        <div className="absolute inset-x-3 top-6 z-20 flex items-center gap-2">
          <Avatar name={group.author.name} src={group.author.avatarUrl ?? undefined} size={30} />
          <span className="text-sm font-semibold">{group.author.name}</span>
          <span className="text-xs text-white/70">{relativeTime(story.createdAt)}</span>
          <span className="flex-1" />
          {isMine && (
            <button onClick={remove} aria-label="Delete story" className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10"><Trash2 size={16} /></button>
          )}
          <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10"><X size={18} /></button>
        </div>

        <div
          className="relative flex flex-1 items-center justify-center overflow-hidden"
          style={!story.media ? { background: story.background || BACKGROUNDS[0] } : undefined}
          onMouseDown={() => setPaused(true)}
          onMouseUp={() => setPaused(false)}
          onTouchStart={() => setPaused(true)}
          onTouchEnd={() => setPaused(false)}
        >
          {story.media?.kind === 'image' && mediaUrl && <img src={mediaUrl} alt="" className="max-h-full max-w-full object-contain" />}
          {story.media?.kind === 'video' && mediaUrl && <video src={mediaUrl} className="max-h-full max-w-full object-contain" autoPlay muted playsInline />}
          {story.caption && (
            <p className={`relative z-10 max-w-[85%] text-center text-2xl font-bold leading-snug ${story.media ? 'absolute bottom-16 rounded-lg bg-black/40 px-3 py-2 text-base' : ''}`}>
              {story.caption}
            </p>
          )}

          <button aria-label="Previous" onClick={() => advance(-1)} className="absolute inset-y-0 left-0 w-1/3" />
          <button aria-label="Next" onClick={() => advance(1)} className="absolute inset-y-0 right-0 w-1/3" />
        </div>

        {isMine ? (
          <button onClick={openViewers} className="flex items-center gap-1.5 px-4 py-3 text-sm font-medium text-white/90">
            <Eye size={16} /> {story.viewCount} {story.viewCount === 1 ? 'view' : 'views'}
          </button>
        ) : (
          <div className="px-4 py-3 text-xs text-white/60">Story · disappears in 24 hours</div>
        )}

        {viewers !== null && (
          <div className="absolute inset-x-0 bottom-0 z-30 max-h-[50%] overflow-y-auto rounded-t-2xl bg-elevated-dark p-3" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold">Seen by {viewers.length}</p>
              <button onClick={() => { setViewers(null); setPaused(false); }} aria-label="Close"><X size={16} /></button>
            </div>
            {viewers.length === 0 && <p className="py-4 text-center text-sm text-white/60">No views yet.</p>}
            {viewers.map((v) => (
              <div key={v.id} className="flex items-center gap-2.5 py-1.5">
                <Avatar name={v.name} src={v.avatarUrl ?? undefined} size={30} />
                <span className="flex-1 text-sm">{v.name}</span>
                <span className="text-xs text-white/50">{relativeTime(v.viewedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
