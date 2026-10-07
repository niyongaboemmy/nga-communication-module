import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, X, Loader2, Eye, Trash2, Image as ImageIcon, Type, ImageOff, Pause, Play, Volume2, VolumeX,
  ChevronLeft, ChevronRight, Send,
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

/** Solid, calm backgrounds for text stories (the old two-hue gradients read
 *  as generated). Stored as a CSS value (max 40 chars server-side), so stories
 *  posted with a gradient keep rendering as they were. */
const BACKGROUNDS = ['#1d4ed8', '#111827', '#047857', '#b91c1c', '#c2410c', '#6d28d9', '#0e7490', '#be185d'];

const initialsOf = (name: string) =>
  name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

/** Same ordering the API uses: me first, then unseen, then newest. */
function sortGroups(groups: FeedStoryGroup[], me: string | undefined): FeedStoryGroup[] {
  return [...groups].sort((a, b) => {
    if (a.author.id === me) return -1;
    if (b.author.id === me) return 1;
    if (a.allViewed !== b.allViewed) return a.allViewed ? 1 : -1;
    return Date.parse(b.latestAt) - Date.parse(a.latestAt);
  });
}

export const StoriesBar: React.FC = () => {
  const { user } = useAuth();
  const [groups, setGroups] = useState<FeedStoryGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [viewerAuthor, setViewerAuthor] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set()); // author ids that just got a live story

  const reload = useCallback(() => {
    api.getStoryGroups().then((g) => { setGroups(g); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // Live sync — a story someone just posted slides into the bar (and into an
  // open viewer's group) without a refetch; a deleted one drops out.
  useEffect(() => {
    const offNew = onSocket('feed:story_new', ({ story }) => {
      const mine = story.author.id === user?.id;
      setGroups((prev) => {
        const existing = prev.find((g) => g.author.id === story.author.id);
        if (existing?.stories.some((st) => st.id === story.id)) return prev;
        const next = existing
          ? prev.map((g) => g !== existing ? g : {
            ...g, stories: [...g.stories, story], latestAt: story.createdAt, allViewed: mine ? g.allViewed : false,
          })
          : [...prev, { author: story.author, stories: [story], allViewed: mine, latestAt: story.createdAt }];
        return sortGroups(next, user?.id);
      });
      if (!mine) {
        setFresh((f) => new Set(f).add(story.author.id));
        window.setTimeout(() => setFresh((f) => { const n = new Set(f); n.delete(story.author.id); return n; }), 4000);
      }
    });
    const offDel = onSocket('feed:story_deleted', ({ storyId }) => {
      setGroups((prev) => prev
        .map((g) => (g.stories.some((st) => st.id === storyId) ? { ...g, stories: g.stories.filter((st) => st.id !== storyId) } : g))
        .filter((g) => g.stories.length > 0));
    });
    return () => { offNew(); offDel(); };
  }, [user?.id]);

  const mine = user ? groups.find((g) => g.author.id === user.id) : undefined;
  const viewerAt = viewerAuthor ? groups.findIndex((g) => g.author.id === viewerAuthor) : -1;

  if (!loaded) return null;

  const others = groups.filter((g) => g.author.id !== user?.id);
  return (
    <ScrollRow>
      <CreateStoryCard name={user?.name ?? '?'} avatarUrl={user?.avatarUrl} hasStory={Boolean(mine)} onClick={() => setComposerOpen(true)} />
      {/* Your own story first, as on Facebook; then everyone else, unseen first. */}
      {mine && <StoryThumb group={mine} isMine onOpen={() => setViewerAuthor(mine.author.id)} />}
      {others.map((g) => (
        <StoryThumb key={g.author.id} group={g} fresh={fresh.has(g.author.id)} onOpen={() => setViewerAuthor(g.author.id)} />
      ))}

      {composerOpen && <StoryComposer onClose={() => setComposerOpen(false)} onPosted={() => { setComposerOpen(false); reload(); }} />}
      {viewerAt >= 0 && (
        <StoryViewer
          groups={groups}
          startAt={viewerAt}
          onClose={() => setViewerAuthor(null)}
          onChanged={reload}
        />
      )}
    </ScrollRow>
  );
};

/** Horizontal strip with round prev/next buttons that appear only when there is more to scroll. */
const ScrollRow: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  const scrollBy = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * 360, behavior: 'smooth' });
  const arrow = 'absolute top-1/2 z-10 hidden h-10 w-10 -translate-y-1/2 place-items-center rounded-full border border-border-light bg-card-light text-text-primary-light shadow-md transition hover:bg-surface-light sm:grid dark:border-border-dark/40 dark:bg-elevated-dark dark:text-text-primary-dark dark:hover:bg-card-dark';
  return (
    <div className="relative">
      <div ref={ref} onScroll={measure} className="feed-hl-scroll -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {children}
      </div>
      {edges.left && <button type="button" onClick={() => scrollBy(-1)} aria-label="Earlier stories" className={`${arrow} -left-3`}><ChevronLeft size={20} /></button>}
      {edges.right && <button type="button" onClick={() => scrollBy(1)} aria-label="More stories" className={`${arrow} -right-3`}><ChevronRight size={20} /></button>}
    </div>
  );
};

const CARD = 'relative h-[200px] w-[112px] shrink-0 overflow-hidden rounded-xl';

/** "Create story": your photo (or initials) filling the top, a blue + on the seam. */
const CreateStoryCard: React.FC<{ name: string; avatarUrl?: string; hasStory: boolean; onClick: () => void }> = ({ name, avatarUrl, hasStory, onClick }) => (
  <button onClick={onClick} className={`${CARD} feed-card-in group flex flex-col justify-start border border-border-light bg-card-light text-left shadow-sm dark:border-border-dark/40 dark:bg-elevated-dark`}>
    <div className="h-[150px] w-full overflow-hidden bg-surface-light dark:bg-card-dark">
      {avatarUrl
        ? <img src={avatarUrl} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
        : <span className="grid h-full w-full place-items-center text-4xl font-semibold text-text-secondary-light transition-transform duration-300 group-hover:scale-105 dark:text-text-secondary-dark">{initialsOf(name)}</span>}
    </div>
    <span className="absolute left-1/2 top-[134px] grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full border-4 border-card-light bg-blue-600 text-white dark:border-elevated-dark">
      <Plus size={16} strokeWidth={2.5} />
    </span>
    <span className="absolute inset-x-0 bottom-0 pb-2.5 text-center text-xs font-semibold text-text-primary-light dark:text-text-primary-dark">
      {hasStory ? 'Add to story' : 'Create story'}
    </span>
  </button>
);

const StoryThumb: React.FC<{ group: FeedStoryGroup; isMine?: boolean; fresh?: boolean; onOpen: () => void }> = ({ group, isMine, fresh, onOpen }) => {
  const cover = group.stories[group.stories.length - 1];
  const { url: coverMediaUrl, broken: coverBroken, onError: onCoverError } = useResilientMediaUrl(cover?.media?.fileId);
  const showCover = coverMediaUrl && !coverBroken;
  return (
    <button
      onClick={onOpen}
      aria-label={`${isMine ? 'Your story' : `${group.author.name}'s story`}${group.allViewed ? '' : ', new'}`}
      className={`${CARD} group text-left text-white shadow-sm ${fresh ? 'feed-story-arrive' : 'feed-card-in'}`}
    >
      <span className="absolute inset-0 transition-transform duration-300 group-hover:scale-105">
        {showCover && cover?.media?.kind === 'image'
          ? <img src={coverMediaUrl} alt="" loading="lazy" decoding="async" onError={onCoverError} className="h-full w-full object-cover" />
          : showCover && cover?.media?.kind === 'video'
            ? <video src={coverMediaUrl} className="h-full w-full object-cover" muted onError={onCoverError} />
            : (
              <span className="grid h-full w-full place-items-center px-3 text-center" style={{ background: cover?.background || BACKGROUNDS[0] }}>
                {cover?.caption && <span className="line-clamp-5 text-[13px] font-semibold leading-snug">{cover.caption}</span>}
              </span>
            )}
      </span>
      {/* Only a light top and bottom shade, so the avatar and name read on any background. */}
      <span className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/55" />
      <span className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />
      <span className={`absolute left-2.5 top-2.5 rounded-full p-[2px] ${group.allViewed ? 'bg-white/50' : 'bg-blue-600'}`}>
        <span className="block rounded-full border-2 border-black/10 bg-white">
          <Avatar name={group.author.name} src={group.author.avatarUrl ?? undefined} size={32} />
        </span>
      </span>
      {fresh && <span className="feed-pill-in absolute right-2 top-3 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold">New</span>}
      <span className="absolute inset-x-2.5 bottom-2.5 line-clamp-2 break-words text-[13px] font-semibold leading-tight [text-shadow:0_1px_2px_rgb(0_0_0/0.5)]">
        {isMine ? 'Your story' : group.author.name}
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

  const { user } = useAuth();
  const tab = (active: boolean) =>
    `flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-colors ${active
      ? 'bg-card-light text-text-primary-light shadow-sm dark:bg-elevated-dark dark:text-text-primary-dark'
      : 'text-text-secondary-light hover:text-text-primary-light dark:text-text-secondary-dark dark:hover:text-text-primary-dark'}`;

  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-black/60 p-3 sm:p-6" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Create story"
        className="flex max-h-full w-full max-w-3xl animate-pop flex-col overflow-hidden rounded-2xl bg-card-light shadow-2xl dark:bg-elevated-dark" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border-light px-5 py-3.5 dark:border-border-dark/40">
          <h2 className="text-base font-semibold text-text-primary-light dark:text-text-primary-dark">Create story</h2>
          <button onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full bg-surface-light hover:bg-border-light dark:bg-card-dark dark:hover:bg-border-dark/40"><X size={18} /></button>
        </div>

        <div className="grid min-h-0 flex-1 overflow-y-auto sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* Controls */}
          <div className="space-y-4 p-5">
            <div className="flex items-center gap-2.5">
              <Avatar name={user?.name ?? '?'} src={user?.avatarUrl} size={40} />
              <div className="leading-tight">
                <p className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">{user?.name}</p>
                <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark">Visible for 24 hours</p>
              </div>
            </div>

            <div className="flex gap-1 rounded-xl bg-surface-light p-1 dark:bg-card-dark" role="tablist" aria-label="Story type">
              <button role="tab" aria-selected={mode === 'text'} onClick={() => { setMode('text'); setMedia(null); }} className={tab(mode === 'text')}>
                <Type size={16} /> Text
              </button>
              <button role="tab" aria-selected={mode === 'media'} onClick={() => fileInput.current?.click()} className={tab(mode === 'media')}>
                <ImageIcon size={16} /> Photo or video
              </button>
            </div>

            {mode === 'text' ? (
              <>
                <label className="block">
                  <span className="sr-only">Story text</span>
                  <textarea
                    value={caption}
                    onChange={(e) => setCaption(e.target.value.slice(0, FEED_LIMITS.STORY_CAPTION_MAX))}
                    placeholder="Start typing"
                    rows={5}
                    autoFocus
                    className="w-full resize-none rounded-xl border border-border-light bg-transparent px-3.5 py-3 text-sm text-text-primary-light outline-none placeholder:text-text-secondary-light focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark/50 dark:text-text-primary-dark"
                  />
                  <span className="mt-1 block text-right text-[11px] text-text-secondary-light dark:text-text-secondary-dark">{caption.length}/{FEED_LIMITS.STORY_CAPTION_MAX}</span>
                </label>
                <div>
                  <p className="mb-2 text-xs font-medium text-text-secondary-light dark:text-text-secondary-dark">Background</p>
                  <div className="flex flex-wrap gap-2">
                    {BACKGROUNDS.map((bg) => (
                      <button key={bg} onClick={() => setBackground(bg)} aria-label={`Background ${bg}`} aria-pressed={background === bg}
                        className={`h-8 w-8 rounded-full ring-offset-2 ring-offset-card-light transition dark:ring-offset-elevated-dark ${background === bg ? 'ring-2 ring-blue-600' : 'hover:scale-105'}`}
                        style={{ background: bg }} />
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <button onClick={() => fileInput.current?.click()} className="w-full rounded-xl border border-dashed border-border-light px-4 py-3 text-sm font-medium text-text-secondary-light hover:border-blue-400 hover:text-blue-600 dark:border-border-dark/50 dark:text-text-secondary-dark">
                  Choose a different photo or video
                </button>
                <label className="block">
                  <span className="sr-only">Caption</span>
                  <input
                    value={caption}
                    onChange={(e) => setCaption(e.target.value.slice(0, FEED_LIMITS.STORY_CAPTION_MAX))}
                    placeholder="Add a caption (optional)"
                    className="w-full rounded-xl border border-border-light bg-transparent px-3.5 py-2.5 text-sm text-text-primary-light outline-none placeholder:text-text-secondary-light focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark/50 dark:text-text-primary-dark"
                  />
                </label>
              </>
            )}

            {error && <p className="text-xs font-medium text-red-600 dark:text-red-400">{error}</p>}
          </div>

          {/* Preview, shaped like the story itself */}
          <div className="flex flex-col items-center gap-2 bg-surface-light p-5 dark:bg-card-dark/60">
            <p className="self-start text-xs font-medium text-text-secondary-light dark:text-text-secondary-dark">Preview</p>
            <div
              className="relative grid aspect-[9/16] w-full max-w-[230px] place-items-center overflow-hidden rounded-xl bg-black text-center text-white shadow-lg"
              style={mode === 'text' ? { background } : undefined}
            >
              {mode === 'media' && media?.previewUrl && media.kind === 'image' && <img src={media.previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />}
              {mode === 'media' && media?.previewUrl && media.kind === 'video' && <video src={media.previewUrl} className="absolute inset-0 h-full w-full object-cover" muted autoPlay loop />}
              {mode === 'media' && media && media.progress < 1 && !media.error && (
                <div className="absolute inset-0 grid place-items-center bg-black/40"><Loader2 className="animate-spin" /></div>
              )}
              {mode === 'text' && (
                <p className="max-w-[85%] whitespace-pre-wrap text-lg font-semibold leading-snug">
                  {caption.trim() || <span className="text-white/60">Start typing</span>}
                </p>
              )}
              {mode === 'media' && caption.trim() && (
                <p className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-3 pt-8 text-left text-[13px] font-medium">{caption}</p>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-light px-5 py-3 dark:border-border-dark/40">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-card-dark">
            Discard
          </button>
          <button onClick={() => void submit()} disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
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
const QUICK_REACTIONS = ['👍', '❤️', '😆', '😮', '😢', '😡'];

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

  // Live updates re-sort/insert groups; follow the author+story we're on by id.
  const placeRef = useRef<{ author?: string; story?: string }>({});
  placeRef.current = { author: group?.author.id, story: story?.id };
  useEffect(() => {
    const { author, story: storyId } = placeRef.current;
    if (!author) return;
    const g = groups.findIndex((x) => x.author.id === author);
    if (g < 0) { onClose(); return; }
    const s = Math.max(0, groups[g]!.stories.findIndex((x) => x.id === storyId));
    setCursor((c) => (c.g === g && c.s === s ? c : { g, s }));
  }, [groups]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const prevGroup = groups[(cursor.g - 1 + groups.length) % groups.length]!;
  const nextGroup = groups[(cursor.g + 1) % groups.length]!;

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-neutral-950 p-0 sm:p-6" onClick={onClose} role="dialog" aria-modal="true" aria-label={`${group.author.name}'s story`}>
      {groups.length > 1 && (
        <GroupChevron side="left" group={prevGroup} onClick={() => jumpGroup(-1)} />
      )}

      <div className="relative flex h-full max-h-[860px] w-full max-w-[420px] flex-col overflow-hidden bg-black text-white sm:rounded-xl" onClick={(e) => e.stopPropagation()}>
        {/* Top shade so the header reads on light photos and colours. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-black/55 to-transparent" />
        {/* Segmented progress — one bar per story in this author's group */}
        <div className="absolute inset-x-3 top-3 z-20 flex gap-1">
          {group.stories.map((s, i) => (
            <div key={s.id} className="h-[2px] flex-1 overflow-hidden rounded-full bg-white/35">
              <div className="h-full origin-left bg-white will-change-transform"
                style={{ transform: `scaleX(${i < cursor.s ? 1 : i === cursor.s ? progress : 0})` }} />
            </div>
          ))}
        </div>

        <div className="absolute inset-x-3 top-6 z-20 flex items-center gap-2.5">
          <Avatar name={group.author.name} src={group.author.avatarUrl ?? undefined} size={36} />
          <div className="min-w-0 leading-tight">
            <span className="block truncate text-sm font-semibold">{isMine ? 'Your story' : group.author.name}</span>
            <span className="text-xs text-white/75">{relativeTime(story.createdAt)}</span>
          </div>
          <span className="flex-1" />
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
            <>
              {/* Blurred fill so portrait/landscape shots still cover the frame edge-to-edge. */}
              <img src={mediaUrl} alt="" aria-hidden className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl" draggable={false} />
              <img src={mediaUrl} alt="" onLoad={() => setMediaReady(true)} onError={onMediaError} className="relative h-full w-full object-contain" draggable={false} />
            </>
          )}
          {story.media?.kind === 'video' && mediaUrl && (
            <video
              ref={videoRef}
              src={mediaUrl}
              className="relative h-full w-full object-contain"
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
          {story.caption && (story.media ? (
            /* Media stories: caption pinned to the bottom of the frame over a scrim,
               so it reads on any photo. `relative` and `absolute` can't share a class
               list — Tailwind's `.relative` wins and the caption would lay out inline. */
            <div className="feed-story-caption pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-4 pb-5 pt-12">
              <p className="max-h-[34vh] overflow-y-auto whitespace-pre-wrap text-[15px] font-medium leading-snug text-white [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]">
                {story.caption}
              </p>
            </div>
          ) : (
            <p className="relative z-10 max-w-[85%] whitespace-pre-wrap text-center text-[26px] font-semibold leading-snug tracking-tight">
              {story.caption}
            </p>
          ))}

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
              className="min-w-0 flex-1 rounded-full border border-white/50 bg-transparent px-4 py-2 text-sm placeholder:text-white/70 focus:border-white focus:outline-none"
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
              <p className="mb-3 font-semibold">Keyboard shortcuts</p>
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

/** Desktop-only side arrows to the previous / next person's stories. */
const GroupChevron: React.FC<{ side: 'left' | 'right'; group: FeedStoryGroup; onClick: () => void }> = ({ side, group, onClick }) => (
  <button
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    aria-label={`${side === 'left' ? 'Previous' : 'Next'}: ${group.author.name}`}
    title={group.author.name}
    className={`hidden h-12 w-12 shrink-0 place-items-center rounded-full bg-white text-neutral-900 shadow-lg transition hover:bg-neutral-200 sm:grid ${side === 'left' ? 'mr-4' : 'ml-4'}`}
  >
    {side === 'left' ? <ChevronLeft size={24} /> : <ChevronRight size={24} />}
  </button>
);
