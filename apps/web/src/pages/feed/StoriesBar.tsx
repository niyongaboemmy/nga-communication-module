import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, X, Loader2, Eye, Trash2, Image as ImageIcon, Type, ImageOff, Pause, Play, Volume2, VolumeX,
  ChevronLeft, ChevronRight, Keyboard, Send,
} from 'lucide-react';
import type { FeedMediaItem, FeedStoryGroup, FeedStoryView, FeedStoryViewer } from '@tupo/shared';
import { FEED_LIMITS } from '@tupo/shared';
import { Avatar } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { useNotify } from '../../context/NotificationContext';
import { onSocket } from '../../lib/socket';
import { uploadFile, probeMedia, validateFile } from '../chat/uploads';
import * as chatApi from '../chat/api';
import { useResilientMediaUrl, firstName, relativeTime } from './lib';
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

  // Somebody else's new/removed story shows up in the bar without a refresh.
  useEffect(() => {
    const offs = [onSocket('feed:story_new', reload), onSocket('feed:story_deleted', reload)];
    return () => offs.forEach((off) => off());
  }, [reload]);

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
  const { url: coverMediaUrl, broken: coverBroken, onError: onCoverError } = useResilientMediaUrl(cover?.media?.fileId);
  const showCover = coverMediaUrl && !coverBroken;
  return (
    <button onClick={onOpen} className="feed-card-in group relative h-40 w-28 shrink-0 overflow-hidden rounded-2xl text-left text-white">
      {showCover && cover?.media?.kind === 'image'
        ? <img src={coverMediaUrl} alt="" loading="lazy" decoding="async" onError={onCoverError} className="absolute inset-0 h-full w-full object-cover" />
        : showCover && cover?.media?.kind === 'video'
          ? <video src={coverMediaUrl} className="absolute inset-0 h-full w-full object-cover" muted onError={onCoverError} />
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

const IMAGE_STORY_MS = 5000;
const TEXT_STORY_MS = 6000;
const VIDEO_STORY_MAX_MS = 30_000;
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

const newNonce = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

interface Cursor { g: number; s: number }

/**
 * Full-screen story player. Facebook semantics: stories inside a group play
 * oldest → newest, the player then rolls on to the next author, and at the
 * end of the bar it loops back to the first author instead of closing.
 *
 * Keyboard: ← → story · ↑ ↓ author · Space pause · M mute · R reply ·
 * ? shortcuts · Esc close. Touch: hold to pause, swipe left/right for the
 * next/previous author, swipe down to close.
 */
const StoryViewer: React.FC<{ groups: FeedStoryGroup[]; startAt: number; onClose: () => void; onChanged: () => void }> = ({
  groups, startAt, onClose, onChanged,
}) => {
  const { user } = useAuth();
  const { notify } = useNotify();
  const [cursor, setCursor] = useState<Cursor>(() => ({
    g: startAt, s: Math.max(0, groups[startAt]!.stories.findIndex((st) => !st.viewed)),
  }));
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);       // press-and-hold on the canvas
  const [userPaused, setUserPaused] = useState(false); // Space / the ⏸ button
  const [overlay, setOverlay] = useState<'viewers' | 'help' | null>(null);
  const [replyFocused, setReplyFocused] = useState(false);
  const [muted, setMuted] = useState(true);
  const [mediaReady, setMediaReady] = useState(false);
  const [durationMs, setDurationMs] = useState(IMAGE_STORY_MS);
  const [viewers, setViewers] = useState<FeedStoryViewer[] | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [slideDir, setSlideDir] = useState<1 | -1>(1);

  const seenRef = useRef(new Set<string>());
  const elapsedRef = useRef(0);
  const lastTsRef = useRef<number | null>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  const replyInputRef = useRef<HTMLInputElement>(null);
  const touchRef = useRef<{ x: number; y: number; t: number } | null>(null);

  const group = groups[cursor.g];
  const story = group?.stories[cursor.s];
  const isMine = story?.author.id === user?.id;
  const paused = holding || userPaused || overlay !== null || replyFocused || sending !== null;
  const { url: mediaUrl, broken: mediaBroken, onError: onMediaError, retry: retryMedia } = useResilientMediaUrl(story?.media?.fileId);

  // Warm the next story's image so the cut is instant, like Facebook.
  const next = useMemo<FeedStoryView | undefined>(() => {
    if (!group) return undefined;
    if (cursor.s + 1 < group.stories.length) return group.stories[cursor.s + 1];
    return groups[(cursor.g + 1) % groups.length]?.stories[0];
  }, [groups, group, cursor]);
  const { url: nextUrl } = useResilientMediaUrl(next?.media?.kind === 'image' ? next.media.fileId : undefined);

  /* ── Navigation ─────────────────────────────────────────────────────── */

  const go = useCallback((target: Cursor, dir: 1 | -1) => {
    setSlideDir(dir);
    setViewers(null);
    setOverlay((o) => (o === 'viewers' ? null : o));
    setCursor(target);
  }, []);

  /** Next/previous story, rolling over into the neighbouring author and
   *  looping around the bar at either end. */
  const step = useCallback((dir: 1 | -1) => {
    if (!group) return;
    const s = cursor.s + dir;
    if (s >= 0 && s < group.stories.length) { go({ g: cursor.g, s }, dir); return; }
    const g = (cursor.g + dir + groups.length) % groups.length;
    go({ g, s: dir === 1 ? 0 : groups[g]!.stories.length - 1 }, dir);
  }, [group, cursor, groups, go]);

  /** Jump straight to the neighbouring author (↑/↓, swipe, side chevrons). */
  const jumpGroup = useCallback((dir: 1 | -1) => {
    const g = (cursor.g + dir + groups.length) % groups.length;
    const firstUnseen = groups[g]!.stories.findIndex((st) => !st.viewed);
    go({ g, s: Math.max(0, firstUnseen) }, dir);
  }, [cursor.g, groups, go]);

  const stepRef = useRef(step);
  stepRef.current = step;

  /* ── Per-story reset + view receipt ─────────────────────────────────── */

  useEffect(() => {
    elapsedRef.current = 0;
    lastTsRef.current = null;
    setProgress(0);
    setReply('');
    setSent(null);
    if (!story) return;
    const isVideo = story.media?.kind === 'video';
    setMediaReady(!story.media);
    setDurationMs(story.media ? IMAGE_STORY_MS : TEXT_STORY_MS);
    if (isVideo) setDurationMs(VIDEO_STORY_MAX_MS);
    if (!seenRef.current.has(story.id)) {
      seenRef.current.add(story.id);
      void api.recordStoryView(story.id);
    }
  }, [story?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A broken image still has to move on eventually; count it as ready.
  useEffect(() => { if (mediaBroken) setMediaReady(true); }, [mediaBroken]);

  /* ── The clock ──────────────────────────────────────────────────────── *
   * Accumulates wall-time only while playing, so pausing never rewinds and
   * switching stories always starts from zero (the old implementation read a
   * stale `progress` and skipped every story after the first).            */
  useEffect(() => {
    if (!story || paused || !mediaReady) { lastTsRef.current = null; return; }
    const tick = (ts: number) => {
      if (lastTsRef.current !== null) elapsedRef.current += ts - lastTsRef.current;
      lastTsRef.current = ts;
      const frac = Math.min(1, elapsedRef.current / durationMs);
      setProgress(frac);
      if (frac >= 1) { stepRef.current(1); return; }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [story?.id, paused, mediaReady, durationMs]);

  // Keep the <video> in lock-step with the clock.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (paused) v.pause();
    else void v.play().catch(() => {});
  }, [paused, story?.id, mediaReady]);

  /* ── Keyboard + body scroll lock ────────────────────────────────────── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT' || (e.target as HTMLElement | null)?.tagName === 'TEXTAREA';
      if (e.key === 'Escape') {
        if (typing) { (e.target as HTMLElement).blur(); return; }
        if (overlay) { setOverlay(null); return; }
        onClose();
        return;
      }
      if (typing) return;
      switch (e.key) {
        case 'ArrowRight': e.preventDefault(); stepRef.current(1); break;
        case 'ArrowLeft': e.preventDefault(); stepRef.current(-1); break;
        case 'ArrowDown': case 'j': e.preventDefault(); jumpGroup(1); break;
        case 'ArrowUp': case 'k': e.preventDefault(); jumpGroup(-1); break;
        case ' ': case 'p': e.preventDefault(); setUserPaused((p) => !p); break;
        case 'm': setMuted((m) => !m); break;
        case 'r': if (!isMine) { e.preventDefault(); replyInputRef.current?.focus(); } break;
        case '?': setOverlay((o) => (o === 'help' ? null : 'help')); break;
        case 'Home': go({ g: cursor.g, s: 0 }, -1); break;
        case 'End': go({ g: cursor.g, s: (group?.stories.length ?? 1) - 1 }, 1); break;
        default: return;
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose, jumpGroup, go, overlay, isMine, cursor.g, group?.stories.length]);

  /* ── Touch: hold to pause, swipe between authors, swipe down to close ── */

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]!;
    touchRef.current = { x: t.clientX, y: t.clientY, t: performance.now() };
    setHolding(true);
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    setHolding(false);
    const start = touchRef.current; touchRef.current = null;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x; const dy = t.clientY - start.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) { e.preventDefault(); jumpGroup(dx < 0 ? 1 : -1); return; }
    if (dy > 90 && Math.abs(dy) > Math.abs(dx)) { e.preventDefault(); onClose(); }
  };

  /* ── Actions ────────────────────────────────────────────────────────── */

  const openViewers = () => {
    if (!story) return;
    setOverlay('viewers');
    api.getStoryViewers(story.id).then(setViewers).catch(() => setViewers([]));
  };

  const remove = async () => {
    if (!story) return;
    await api.deleteStory(story.id).catch(() => {});
    onChanged();
    if (group && group.stories.length <= 1 && groups.length <= 1) { onClose(); return; }
    step(1);
  };

  /** Replies and quick reactions land in a DM with the author, quoting the
   *  story — the same place Facebook puts them, and no new backend. */
  const sendToAuthor = async (body: string, kind: 'reply' | 'reaction') => {
    if (!story || !group || isMine || sending) return;
    setSending(kind);
    const quoted = story.caption ? ` “${story.caption.slice(0, 80)}${story.caption.length > 80 ? '…' : ''}”` : '';
    const text = kind === 'reaction' ? `${body}  ·  reacted to your story${quoted}` : `↩︎ Replying to your story${quoted}\n${body}`;
    try {
      const conversation = await chatApi.openDirect(group.author.id);
      await chatApi.sendMessage(conversation.id, {
        body: text, nonce: newNonce(),
        metadata: { storyReply: { storyId: story.id, kind, caption: story.caption, reaction: kind === 'reaction' ? body : undefined } },
      });
      setReply('');
      setSent(kind === 'reaction' ? body : 'Sent');
      window.setTimeout(() => setSent(null), 1400);
    } catch (err) {
      notify({ title: 'Could not send that', body: err instanceof Error ? err.message : undefined, tone: 'error' });
    } finally {
      setSending(null);
      replyInputRef.current?.blur();
    }
  };

  if (!group || !story) return null;

  const secondsLeft = Math.max(0, Math.ceil(((1 - progress) * durationMs) / 1000));
  const prevGroup = groups[(cursor.g - 1 + groups.length) % groups.length]!;
  const nextGroup = groups[(cursor.g + 1) % groups.length]!;
  const showPausedBadge = paused && overlay === null && !replyFocused && !sending;

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/90 p-2 sm:p-6" onClick={onClose} role="dialog" aria-modal="true" aria-label={`${group.author.name}'s story`}>
      {groups.length > 1 && (
        <GroupChevron side="left" group={prevGroup} onClick={() => jumpGroup(-1)} />
      )}

      <div className="relative flex h-full max-h-[860px] w-full max-w-[420px] flex-col overflow-hidden rounded-2xl bg-black text-white" onClick={(e) => e.stopPropagation()}>
        {/* Segmented progress — one bar per story in this author's group */}
        <div className="absolute inset-x-2 top-2 z-20 flex gap-1">
          {group.stories.map((s, i) => (
            <div key={s.id} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/30">
              <div className="h-full origin-left bg-white will-change-transform"
                style={{ transform: `scaleX(${i < cursor.s ? 1 : i === cursor.s ? progress : 0})` }} />
            </div>
          ))}
        </div>

        <div className="absolute inset-x-3 top-6 z-20 flex items-center gap-2">
          <Avatar name={group.author.name} src={group.author.avatarUrl ?? undefined} size={30} />
          <div className="min-w-0 leading-tight">
            <span className="block truncate text-sm font-semibold">{isMine ? 'Your story' : group.author.name}</span>
            <span className="text-[11px] text-white/70">{relativeTime(story.createdAt)} · {cursor.s + 1}/{group.stories.length}</span>
          </div>
          <span className="flex-1" />
          <CountdownRing progress={progress} seconds={secondsLeft} paused={paused} />
          <button onClick={() => setUserPaused((p) => !p)} aria-label={userPaused ? 'Play' : 'Pause'} title="Space" className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10">
            {userPaused ? <Play size={16} /> : <Pause size={16} />}
          </button>
          {story.media?.kind === 'video' && (
            <button onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Unmute' : 'Mute'} title="M" className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10">
              {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
          )}
          {isMine && (
            <button onClick={remove} aria-label="Delete story" className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10"><Trash2 size={16} /></button>
          )}
          <button onClick={() => setOverlay((o) => (o === 'help' ? null : 'help'))} aria-label="Keyboard shortcuts" title="?" className="hidden h-8 w-8 place-items-center rounded-full hover:bg-white/10 sm:grid"><Keyboard size={16} /></button>
          <button onClick={onClose} aria-label="Close" title="Esc" className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10"><X size={18} /></button>
        </div>

        <div
          key={story.id}
          className={`relative flex flex-1 select-none items-center justify-center overflow-hidden ${slideDir === 1 ? 'feed-story-in-right' : 'feed-story-in-left'}`}
          style={!story.media ? { background: story.background || BACKGROUNDS[0] } : undefined}
          onMouseDown={() => setHolding(true)}
          onMouseUp={() => setHolding(false)}
          onMouseLeave={() => setHolding(false)}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onTouchCancel={() => { setHolding(false); touchRef.current = null; }}
        >
          {story.media?.kind === 'image' && mediaUrl && (
            <img src={mediaUrl} alt="" onLoad={() => setMediaReady(true)} onError={onMediaError} className="max-h-full max-w-full object-contain" draggable={false} />
          )}
          {story.media?.kind === 'video' && mediaUrl && (
            <video
              ref={videoRef}
              src={mediaUrl}
              className="max-h-full max-w-full object-contain"
              autoPlay muted={muted} playsInline
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration;
                if (Number.isFinite(d) && d > 0) setDurationMs(Math.min(VIDEO_STORY_MAX_MS, Math.round(d * 1000)));
              }}
              onCanPlay={() => setMediaReady(true)}
              onWaiting={() => setMediaReady(false)}
              onPlaying={() => setMediaReady(true)}
              onError={onMediaError}
            />
          )}
          {story.media && !mediaReady && !mediaBroken && (
            <div className="absolute inset-0 grid place-items-center">
              <div className="feed-skeleton absolute inset-0" />
              <Loader2 className="relative animate-spin text-white/70" />
            </div>
          )}
          {story.media && mediaBroken && (
            <button onClick={(e) => { e.stopPropagation(); retryMedia(); }} className="flex flex-col items-center gap-2 text-white/70">
              <ImageOff size={28} /> <span className="text-sm font-medium">Couldn't load. Tap to retry.</span>
            </button>
          )}
          {story.caption && (
            <p className={`relative z-10 max-w-[85%] text-center text-2xl font-bold leading-snug ${story.media ? 'absolute bottom-16 rounded-lg bg-black/40 px-3 py-2 text-base' : ''}`}>
              {story.caption}
            </p>
          )}

          {showPausedBadge && (
            <span className="feed-pill-in absolute left-1/2 top-16 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/50 px-3 py-1 text-xs font-semibold backdrop-blur">
              <Pause size={12} /> Paused
            </span>
          )}
          {sent && (
            <span className="feed-story-sent pointer-events-none absolute inset-0 z-20 grid place-items-center">
              <span className="rounded-full bg-black/60 px-5 py-2 text-3xl backdrop-blur">{sent === 'Sent' ? <span className="text-base font-semibold">Sent ✓</span> : sent}</span>
            </span>
          )}

          {/* Tap zones — a click is a tap only if the pointer barely moved. */}
          <button aria-label="Previous story" onClick={() => step(-1)} className="absolute inset-y-0 left-0 w-1/3 cursor-w-resize" />
          <button aria-label="Next story" onClick={() => step(1)} className="absolute inset-y-0 right-0 w-1/3 cursor-e-resize" />
        </div>

        {isMine ? (
          <button onClick={openViewers} className="flex items-center gap-1.5 px-4 py-3 text-sm font-medium text-white/90 hover:bg-white/5">
            <Eye size={16} /> {story.viewCount} {story.viewCount === 1 ? 'view' : 'views'}
          </button>
        ) : (
          <form
            className="flex items-center gap-1.5 px-3 py-2.5"
            onSubmit={(e) => { e.preventDefault(); if (reply.trim()) void sendToAuthor(reply.trim(), 'reply'); }}
          >
            <input
              ref={replyInputRef}
              value={reply}
              onChange={(e) => setReply(e.target.value.slice(0, 500))}
              onFocus={() => setReplyFocused(true)}
              onBlur={() => setReplyFocused(false)}
              placeholder={`Reply to ${firstName(group.author.name)}…`}
              className="min-w-0 flex-1 rounded-full border border-white/25 bg-white/10 px-3.5 py-2 text-sm placeholder:text-white/60 focus:border-white/60 focus:outline-none"
            />
            {reply.trim() ? (
              <button type="submit" disabled={sending !== null} aria-label="Send reply" className="grid h-9 w-9 place-items-center rounded-full bg-blue-600 text-white disabled:opacity-50">
                {sending === 'reply' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            ) : (
              <div className="flex items-center">
                {QUICK_REACTIONS.map((emoji) => (
                  <button key={emoji} type="button" onClick={() => void sendToAuthor(emoji, 'reaction')} disabled={sending !== null}
                    aria-label={`React ${emoji}`} className="feed-story-react grid h-9 w-8 place-items-center text-xl disabled:opacity-50">
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </form>
        )}

        {overlay === 'viewers' && (
          <div className="absolute inset-x-0 bottom-0 z-30 max-h-[50%] overflow-y-auto rounded-t-2xl bg-elevated-dark p-3 animate-pop" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold">Seen by {viewers?.length ?? story.viewCount}</p>
              <button onClick={() => setOverlay(null)} aria-label="Close"><X size={16} /></button>
            </div>
            {viewers === null && <div className="py-4 text-center"><Loader2 className="mx-auto animate-spin text-white/60" /></div>}
            {viewers?.length === 0 && <p className="py-4 text-center text-sm text-white/60">No views yet.</p>}
            {viewers?.map((v) => (
              <div key={v.id} className="flex items-center gap-2.5 py-1.5">
                <Avatar name={v.name} src={v.avatarUrl ?? undefined} size={30} />
                <span className="flex-1 text-sm">{v.name}</span>
                <span className="text-xs text-white/50">{relativeTime(v.viewedAt)}</span>
              </div>
            ))}
          </div>
        )}

        {overlay === 'help' && (
          <div className="absolute inset-0 z-30 grid place-items-center bg-black/70 p-6 animate-fade-in" onClick={() => setOverlay(null)}>
            <div className="w-full max-w-xs rounded-2xl bg-elevated-dark p-4 text-sm" onClick={(e) => e.stopPropagation()}>
              <p className="mb-3 flex items-center gap-2 font-semibold"><Keyboard size={16} /> Shortcuts</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                {([
                  ['← →', 'Previous / next story'],
                  ['↑ ↓', 'Previous / next person'],
                  ['Space', 'Pause / resume'],
                  ['M', 'Mute / unmute video'],
                  ['R', 'Reply'],
                  ['Home / End', 'First / last of this person'],
                  ['Esc', 'Close'],
                ] as const).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt><kbd className="rounded bg-white/15 px-1.5 py-0.5 font-mono text-xs">{k}</kbd></dt>
                    <dd className="text-white/80">{v}</dd>
                  </React.Fragment>
                ))}
              </dl>
              <p className="mt-3 text-xs text-white/50">Hold to pause · swipe sideways for the next person · swipe down to close.</p>
            </div>
          </div>
        )}
      </div>

      {groups.length > 1 && (
        <GroupChevron side="right" group={nextGroup} onClick={() => jumpGroup(1)} />
      )}

      {nextUrl && <img src={nextUrl} alt="" aria-hidden className="hidden" />}
    </div>
  );
};

/** Circular "seconds left" indicator — the segmented bar shows position, this
 *  shows the countdown ticking, which reads better at a glance. */
const CountdownRing: React.FC<{ progress: number; seconds: number; paused: boolean }> = ({ progress, seconds, paused }) => {
  const r = 11; const c = 2 * Math.PI * r;
  return (
    <span className={`relative grid h-8 w-8 place-items-center ${paused ? 'opacity-60' : ''}`} aria-label={`${seconds} seconds left`} title={`${seconds}s`}>
      <svg viewBox="0 0 28 28" className="absolute inset-0 h-full w-full -rotate-90">
        <circle cx="14" cy="14" r={r} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2.5" />
        <circle cx="14" cy="14" r={r} fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * progress} />
      </svg>
      <span key={seconds} className="feed-count-tick relative text-[10px] font-bold tabular-nums leading-none">{seconds}</span>
    </span>
  );
};

/** Desktop-only side arrows that carry a peek of the neighbouring author. */
const GroupChevron: React.FC<{ side: 'left' | 'right'; group: FeedStoryGroup; onClick: () => void }> = ({ side, group, onClick }) => (
  <button
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    aria-label={`${side === 'left' ? 'Previous' : 'Next'}: ${group.author.name}`}
    title={group.author.name}
    className={`group hidden shrink-0 flex-col items-center gap-2 px-3 text-white/70 hover:text-white sm:flex ${side === 'left' ? 'mr-2' : 'ml-2'}`}
  >
    <span className={`grid h-11 w-11 place-items-center rounded-full bg-white/10 transition-colors group-hover:bg-white/20 ${group.allViewed ? '' : 'ring-2 ring-blue-500'}`}>
      {side === 'left' ? <ChevronLeft size={22} /> : <ChevronRight size={22} />}
    </span>
    <span className="flex items-center gap-1.5 text-xs opacity-0 transition-opacity group-hover:opacity-100">
      <Avatar name={group.author.name} src={group.author.avatarUrl ?? undefined} size={18} />
      {firstName(group.author.name)}
    </span>
  </button>
);
