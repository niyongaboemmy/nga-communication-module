import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  BadgeCheck, Bell, BellOff, Plus, BarChart3, ArrowLeft, Users, Search, X, Loader2, Settings2, Camera,
} from 'lucide-react';
import type {
  CreatePagePayload, FeedPageDetail, FeedPageKind, FeedPageSummary, FeedPostView, FeedPageAnalytics,
} from '@tupo/shared';
import { FEED_PAGE_KINDS, FEED_AUDIENCES } from '@tupo/shared';
import { Avatar, EmptyState, Spinner } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useNotify } from '../../context/NotificationContext';
import { uploadFile, validateFile } from '../chat/uploads';
import { useFeed, useFeedList } from './FeedProvider';
import { FeedFrame, useFeedRails, PostSkeleton, PostCard, ReportDialog, EditPostMount } from './Frame';
import { Composer } from './Composer';
import { useMediaUrl } from './lib';
import * as api from './api';

/**
 * A hover-to-change image well used for a page's avatar and cover, in both
 * the create dialog (uploads straight away, hands back a fileId to hold
 * until Create is pressed) and the profile header (uploads and saves
 * immediately, Facebook-style — there's no separate "save" step for a
 * cover photo).
 */
const BrandingImageButton: React.FC<{
  shape: 'circle' | 'cover';
  src?: string;
  fallback?: React.ReactNode;
  editable: boolean;
  onFile: (file: File) => void;
  busy?: boolean;
  label: string;
  className?: string;
}> = ({ shape, src, fallback, editable, onFile, busy, label, className = '' }) => {
  const input = useRef<HTMLInputElement>(null);
  const shapeClass = shape === 'circle' ? 'rounded-full' : '';
  return (
    <div className={`group relative overflow-hidden ${shapeClass} ${className}`}>
      {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : (fallback ?? <div className="h-full w-full bg-gradient-to-br from-blue-500 to-indigo-600" />)}
      {editable && (
        <button
          type="button"
          aria-label={label}
          title={label}
          onClick={() => input.current?.click()}
          disabled={busy}
          className={`absolute inset-0 grid place-items-center bg-black/0 text-white opacity-0 transition-all duration-150 hover:bg-black/40 hover:opacity-100 focus-visible:bg-black/40 focus-visible:opacity-100 group-hover:opacity-100 ${shapeClass}`}
        >
          {busy ? <Loader2 size={shape === 'circle' ? 18 : 22} className="animate-spin" /> : <Camera size={shape === 'circle' ? 18 : 22} />}
        </button>
      )}
      {editable && (
        <input ref={input} type="file" accept="image/*" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      )}
    </div>
  );
};

/* ════════════════════════════════════════════════════════ Page profile ══ */

export const PageProfile: React.FC = () => {
  const { slug = '' } = useParams();
  const { posts, ingest } = useFeed();
  const { can } = usePermissions();
  const { notify, confirm } = useNotify();
  const [page, setPage] = useState<FeedPageDetail | null>(null);
  const [tab, setTab] = useState<'posts' | 'about'>('posts');
  const [allPages, setAllPages] = useState<FeedPageSummary[]>([]);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const cover = useMediaUrl(page?.coverFileId);
  const avatar = useMediaUrl(page?.avatarFileId);

  const reload = useCallback(() => { void api.getPage(slug).then(setPage); }, [slug]);
  useEffect(() => { reload(); void api.listPages().then(setAllPages); }, [reload]);

  const loader = useCallback((cursor?: string) => api.getPagePosts(page?.id ?? slug, { cursor }), [page?.id, slug]);
  const list = useFeedList(loader, [page?.id ?? slug]);
  const items = list.ids.map((id) => posts[id]).filter((p): p is FeedPostView => Boolean(p));
  const { left, right } = useFeedRails();

  if (!page) return <div className="grid h-full place-items-center"><Spinner /></div>;

  /*
   * Mirrors assertPageOwner on the server: a page's branding belongs to whoever
   * owns that page, and to nobody else.
   *
   * This used to read `|| can(['FEED_PAGE_MANAGE'])`, which put "Change page
   * photo" on every page in the school for anyone holding a permission that
   * only ever meant "you may create pages". The server agreed with it, so the
   * upload went through — the visible half of the bug.
   */
  const canManage = page.myRole === 'owner';

  const toggleFollow = async () => {
    const updated = page.following ? await api.unfollowPage(page.id) : await api.followPage(page.id);
    setPage({ ...page, ...updated });
  };
  const toggleNotify = async () => {
    await api.setPageNotify(page.id, !page.notify);
    setPage({ ...page, notify: !page.notify });
  };

  const uploadBranding = async (file: File, kind: 'avatarFileId' | 'coverFileId') => {
    const invalid = validateFile(file);
    if (invalid) { notify({ title: invalid, tone: 'error' }); return; }
    const setBusy = kind === 'avatarFileId' ? setAvatarBusy : setCoverBusy;
    setBusy(true);
    try {
      const fileId = await uploadFile(file, () => {}).promise;
      const updated = await api.updatePage(page.id, { [kind]: fileId });
      setPage(updated);
      confirm(kind === 'avatarFileId' ? 'Page photo updated' : 'Cover photo updated');
    } catch (e) {
      notify({ title: e instanceof Error ? e.message : 'Could not update the photo', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <FeedFrame left={left} right={right}>
        <div className="mx-auto max-w-2xl">
          <Link to="/app/feed" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary-light hover:text-text-primary-light dark:text-text-secondary-dark">
            <ArrowLeft size={15} /> Back to feed
          </Link>
          <div className="overflow-hidden rounded-2xl border border-border-light bg-card-light shadow-sm transition-shadow hover:shadow-md dark:border-border-dark/40 dark:bg-elevated-dark/50">
            <BrandingImageButton
              shape="cover" src={cover} editable={canManage} busy={coverBusy} label="Change cover photo"
              onFile={(f) => void uploadBranding(f, 'coverFileId')}
              className="h-36 w-full sm:h-48"
              fallback={<div className="h-full w-full" style={{ background: `linear-gradient(130deg, ${page.accent}, #1e293b)` }} />}
            />
            <div className="px-4 pb-4">
              <div className="-mt-10 flex items-end justify-between">
                <BrandingImageButton
                  shape="circle" src={avatar} editable={canManage} busy={avatarBusy} label="Change page photo"
                  onFile={(f) => void uploadBranding(f, 'avatarFileId')}
                  className="h-20 w-20 shrink-0 ring-4 ring-card-light dark:ring-elevated-dark"
                  fallback={<Avatar name={page.name} size={80} />}
                />
                <div className="mb-1 flex items-center gap-2">
                  {page.following && (
                    <button onClick={toggleNotify} aria-label="Notifications" className="grid h-9 w-9 place-items-center rounded-full border border-border-light text-text-secondary-light hover:bg-surface-light dark:border-border-dark/60 dark:hover:bg-card-dark">
                      {page.notify ? <Bell size={16} /> : <BellOff size={16} />}
                    </button>
                  )}
                  <button
                    onClick={toggleFollow}
                    disabled={page.mandatory && page.following}
                    className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
                      page.following ? 'border border-border-light text-text-primary-light hover:bg-surface-light dark:border-border-dark/60 dark:text-text-primary-dark' : 'bg-blue-600 text-white hover:bg-blue-700'
                    } disabled:opacity-60`}
                  >
                    {page.mandatory && page.following ? 'Required' : page.following ? 'Following' : 'Follow'}
                  </button>
                  {page.myRole && (
                    <Link to={`/app/feed/pages/${page.id}/insights`} aria-label="Insights" className="grid h-9 w-9 place-items-center rounded-full border border-border-light text-text-secondary-light hover:bg-surface-light dark:border-border-dark/60 dark:hover:bg-card-dark">
                      <BarChart3 size={16} />
                    </Link>
                  )}
                </div>
              </div>
              <h1 className="mt-2 flex items-center gap-1.5 text-lg font-bold text-text-primary-light dark:text-text-primary-dark">
                {page.name} {page.verified && <BadgeCheck size={17} className="text-blue-500" />}
              </h1>
              <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark">{page.bio}</p>
              <p className="mt-1 flex items-center gap-3 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                <span className="flex items-center gap-1"><Users size={12} /> {page.followerCount} followers</span>
                <span>· {page.postCount} posts</span>
                <span className="capitalize">· {page.kind}</span>
              </p>
            </div>
          </div>

          <div className="mt-4 flex gap-1 border-b border-border-light dark:border-border-dark/40">
            {(['posts', 'about'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-semibold capitalize transition-colors ${
                tab === t ? 'border-b-2 border-blue-600 text-blue-600 dark:text-blue-400' : 'text-text-secondary-light dark:text-text-secondary-dark'
              }`}>{t}</button>
            ))}
          </div>

          {tab === 'about' ? (
            <div className="mt-4 space-y-3 rounded-2xl border border-border-light bg-card-light p-4 text-sm dark:border-border-dark/40 dark:bg-elevated-dark/40">
              <p className="text-text-primary-light dark:text-text-primary-dark">{page.bio || 'No description yet.'}</p>
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">Editors</p>
                <div className="flex flex-wrap gap-2">
                  {page.editors.map((e) => (
                    <span key={e.id} className="flex items-center gap-1.5 rounded-full bg-surface-light px-2 py-1 text-xs dark:bg-card-dark/50">
                      <Avatar name={e.name} src={e.avatarUrl ?? undefined} size={18} /> {e.name} · {e.role}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              {page.canPost && <Composer pages={allPages} defaultPageId={page.id} onPublished={(p) => { if (p) { list.prepend(p.id); ingest([p]); } }} />}
              {list.loading ? <><PostSkeleton /><PostSkeleton /></>
                : items.length === 0 ? <EmptyState title="No posts yet" hint={page.canPost ? 'Share the first update.' : 'Check back soon.'} />
                : items.map((post) => <PostCard key={post.id} post={post} />)}
              {list.hasMore && <button onClick={list.loadMore} className="mx-auto block rounded-full border border-border-light px-5 py-2 text-sm font-semibold dark:border-border-dark/50">Load more</button>}
            </div>
          )}
        </div>
      </FeedFrame>
      <ReportDialog />
      <EditPostMount pages={allPages} />
    </>
  );
};

/* ═══════════════════════════════════════════════════════ Page directory ══ */

export const PageDirectory: React.FC = () => {
  const { can } = usePermissions();
  const [pages, setPages] = useState<FeedPageSummary[]>([]);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<FeedPageKind | 'all'>('all');
  const [creating, setCreating] = useState(false);

  const reload = useCallback(() => {
    void api.listPages({ q: q || undefined, kind: kind === 'all' ? undefined : kind }).then(setPages);
  }, [q, kind]);
  useEffect(() => { const t = setTimeout(reload, 200); return () => clearTimeout(t); }, [reload]);

  const follow = async (id: string, following: boolean) => {
    const updated = following ? await api.unfollowPage(id) : await api.followPage(id);
    setPages((p) => p.map((x) => (x.id === id ? updated : x)));
  };
  const { left, right } = useFeedRails();

  return (
    <FeedFrame left={left} right={right}>
      <div className="mx-auto max-w-3xl">
        <Link to="/app/feed" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary-light hover:text-text-primary-light lg:hidden dark:text-text-secondary-dark">
          <ArrowLeft size={15} /> Back to feed
        </Link>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-bold text-text-primary-light dark:text-text-primary-dark">Pages</h1>
          {can(['FEED_PAGE_MANAGE']) && (
            <button onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              <Plus size={16} /> Create page
            </button>
          )}
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-full border border-border-light bg-card-light px-3 py-2 dark:border-border-dark/50 dark:bg-elevated-dark/40">
            <Search size={15} className="text-text-secondary-light" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages" className="flex-1 bg-transparent text-sm outline-none" />
          </div>
          <select value={kind} onChange={(e) => setKind(e.target.value as FeedPageKind | 'all')} className="rounded-full border border-border-light bg-card-light px-3 py-2 text-sm capitalize outline-none dark:border-border-dark/50 dark:bg-elevated-dark/40">
            <option value="all">All types</option>
            {FEED_PAGE_KINDS.map((k) => <option key={k} value={k} className="capitalize dark:bg-elevated-dark">{k}</option>)}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {pages.map((p) => <PageDirCard key={p.id} page={p} onFollow={() => follow(p.id, p.following)} />)}
        </div>
        {pages.length === 0 && <EmptyState title="No pages found" hint="Try a different search." />}
      </div>
      {creating && <CreatePageDialog onClose={() => setCreating(false)} onCreated={reload} />}
    </FeedFrame>
  );
};

const PageDirCard: React.FC<{ page: FeedPageSummary; onFollow: () => void }> = ({ page, onFollow }) => {
  const avatar = useMediaUrl(page.avatarFileId);
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border-light bg-card-light p-3 dark:border-border-dark/40 dark:bg-elevated-dark/40">
      <Link to={`/app/feed/p/${page.slug}`}><Avatar name={page.name} src={avatar} size={44} /></Link>
      <div className="min-w-0 flex-1">
        <Link to={`/app/feed/p/${page.slug}`} className="flex items-center gap-1 text-sm font-semibold text-text-primary-light hover:underline dark:text-text-primary-dark">
          {page.name} {page.verified && <BadgeCheck size={13} className="text-blue-500" />}
        </Link>
        <p className="truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">{page.followerCount} followers · {page.bio || page.kind}</p>
      </div>
      <button onClick={onFollow} disabled={page.mandatory && page.following}
        className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
          page.following ? 'border border-border-light text-text-primary-light dark:border-border-dark/60 dark:text-text-primary-dark' : 'bg-blue-600 text-white'
        } disabled:opacity-60`}>
        {page.mandatory && page.following ? 'Required' : page.following ? 'Following' : 'Follow'}
      </button>
    </div>
  );
};

const CreatePageDialog: React.FC<{ onClose: () => void; onCreated: () => void }> = ({ onClose, onCreated }) => {
  const nav = useNavigate();
  const { notify } = useNotify();
  const [form, setForm] = useState<CreatePagePayload>({ name: '', kind: 'community', audience: 'everyone', accent: '#2563eb', bio: '' });
  const [avatarPreview, setAvatarPreview] = useState<string>();
  const [coverPreview, setCoverPreview] = useState<string>();
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The object URLs are only ever needed while this dialog is open.
  useEffect(() => () => { if (avatarPreview) URL.revokeObjectURL(avatarPreview); if (coverPreview) URL.revokeObjectURL(coverPreview); }, [avatarPreview, coverPreview]);

  const pickImage = async (file: File, kind: 'avatarFileId' | 'coverFileId') => {
    const invalid = validateFile(file);
    if (invalid) { notify({ title: invalid, tone: 'error' }); return; }
    (kind === 'avatarFileId' ? setAvatarPreview : setCoverPreview)(URL.createObjectURL(file));
    const setBusy2 = kind === 'avatarFileId' ? setAvatarBusy : setCoverBusy;
    setBusy2(true);
    try {
      const fileId = await uploadFile(file, () => {}).promise;
      setForm((f) => ({ ...f, [kind]: fileId }));
    } catch (e) {
      notify({ title: e instanceof Error ? e.message : 'Could not upload the image', tone: 'error' });
    } finally {
      setBusy2(false);
    }
  };

  const submit = async () => {
    if (!form.name.trim()) return;
    setBusy(true); setErr(null);
    try { const page = await api.createPage(form); onCreated(); onClose(); nav(`/app/feed/p/${page.slug}`); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not create the page.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md animate-pop overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl dark:border-border-dark/50 dark:bg-elevated-dark" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark"><Settings2 size={15} /> Create a page</h2>
          <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-text-secondary-light hover:bg-surface-light dark:hover:bg-card-dark"><X size={18} /></button>
        </div>

        <BrandingImageButton
          shape="cover" src={coverPreview} editable busy={coverBusy} label="Add a cover photo"
          onFile={(f) => void pickImage(f, 'coverFileId')}
          className="mt-3 h-24 w-full"
          fallback={<div className="h-full w-full" style={{ background: `linear-gradient(130deg, ${form.accent}, #1e293b)` }} />}
        />
        <div className="-mt-8 px-5">
          <BrandingImageButton
            shape="circle" src={avatarPreview} editable busy={avatarBusy} label="Add a page photo"
            onFile={(f) => void pickImage(f, 'avatarFileId')}
            className="h-14 w-14 ring-4 ring-white dark:ring-elevated-dark"
            fallback={<Avatar name={form.name || '?'} size={56} />}
          />
        </div>

        <div className="space-y-2.5 px-5 pb-5 pt-3">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Page name" autoFocus
            className="w-full rounded-lg border border-border-light bg-surface-light px-3 py-2 text-sm outline-none dark:border-border-dark/60 dark:bg-card-dark/50" />
          <textarea value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} rows={2} placeholder="What is this page about?"
            className="w-full resize-none rounded-lg border border-border-light bg-surface-light px-3 py-2 text-sm outline-none dark:border-border-dark/60 dark:bg-card-dark/50" />
          <div className="flex gap-2">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as FeedPageKind })} className="flex-1 rounded-lg border border-border-light bg-surface-light px-2 py-2 text-sm capitalize dark:border-border-dark/60 dark:bg-card-dark/50">
              {FEED_PAGE_KINDS.map((k) => <option key={k} value={k} className="capitalize dark:bg-elevated-dark">{k}</option>)}
            </select>
            <select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as CreatePagePayload['audience'] })} className="flex-1 rounded-lg border border-border-light bg-surface-light px-2 py-2 text-sm capitalize dark:border-border-dark/60 dark:bg-card-dark/50">
              {FEED_AUDIENCES.map((a) => <option key={a} value={a} className="capitalize dark:bg-elevated-dark">{a}</option>)}
            </select>
            <input type="color" value={form.accent} onChange={(e) => setForm({ ...form, accent: e.target.value })} className="h-10 w-12 rounded-lg border border-border-light dark:border-border-dark/60" />
          </div>
          {err && <p className="text-xs font-medium text-red-600 dark:text-red-400">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border-light px-5 py-3 dark:border-border-dark/40">
          <button onClick={onClose} className="rounded-full px-3 py-1.5 text-sm text-text-secondary-light dark:text-text-secondary-dark">Cancel</button>
          <button onClick={() => void submit()} disabled={busy || avatarBusy || coverBusy || !form.name.trim()} className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white transition-opacity hover:bg-blue-700 disabled:opacity-40">
            {busy && <Loader2 size={13} className="animate-spin" />} Create
          </button>
        </div>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════ Insights ══ */

export const PageInsights: React.FC = () => {
  const { id = '' } = useParams();
  const [range, setRange] = useState<'7d' | '30d' | 'all'>('30d');
  const [data, setData] = useState<FeedPageAnalytics | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setData(null); void api.getPageAnalytics(id, range).then(setData).catch((e) => setErr(String(e.message ?? e))); }, [id, range]);

  const tiles = useMemo(() => data ? [
    { label: 'Impressions', value: data.totals.impressions },
    { label: 'Unique reach', value: data.totals.uniqueReach },
    { label: 'Reactions', value: data.totals.reactions },
    { label: 'Comments', value: data.totals.comments },
    { label: 'Shares', value: data.totals.shares },
    { label: 'Followers', value: data.totals.followerCount, delta: data.totals.followerGrowth },
  ] : [], [data]);
  const { left, right } = useFeedRails();

  return (
    <FeedFrame left={left} right={right}>
      <div className="mx-auto max-w-2xl">
        <button onClick={() => history.back()} className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary-light">
          <ArrowLeft size={15} /> Back
        </button>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="flex items-center gap-2 text-lg font-bold text-text-primary-light dark:text-text-primary-dark"><BarChart3 size={18} /> Page insights</h1>
          <div className="flex gap-1 rounded-full border border-border-light p-0.5 text-xs dark:border-border-dark/50">
            {(['7d', '30d', 'all'] as const).map((r) => (
              <button key={r} onClick={() => setRange(r)} className={`rounded-full px-2.5 py-1 font-semibold ${range === r ? 'bg-blue-600 text-white' : 'text-text-secondary-light dark:text-text-secondary-dark'}`}>{r}</button>
            ))}
          </div>
        </div>
        {err ? <EmptyState title="No access" hint={err} />
          : !data ? <div className="py-10 text-center"><Spinner /></div>
          : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {tiles.map((t) => (
                <div key={t.label} className="rounded-xl border border-border-light bg-card-light p-3 dark:border-border-dark/40 dark:bg-elevated-dark/40">
                  <p className="text-xs font-medium text-text-secondary-light dark:text-text-secondary-dark">{t.label}</p>
                  <p className="mt-1 text-xl font-bold tabular-nums text-text-primary-light dark:text-text-primary-dark">{t.value.toLocaleString()}</p>
                  {'delta' in t && t.delta !== undefined && <p className="text-[11px] font-semibold text-emerald-600">+{t.delta} this period</p>}
                </div>
              ))}
            </div>
            <Sparkline series={data.series} />
            <div className="rounded-xl border border-border-light bg-card-light p-3 dark:border-border-dark/40 dark:bg-elevated-dark/40">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">Top posts</p>
              <ul className="space-y-2">
                {data.topPosts.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 text-sm">
                    <Link to={`/app/feed/post/${p.id}`} className="min-w-0 flex-1 truncate text-text-primary-light hover:underline dark:text-text-primary-dark">{p.body || '(media post)'}</Link>
                    <span className="shrink-0 text-xs text-text-secondary-light dark:text-text-secondary-dark tabular-nums">{p.impressions} views · {p.reactions} 👍 · {p.comments} 💬</span>
                  </li>
                ))}
                {data.topPosts.length === 0 && <li className="text-xs text-text-secondary-light">No posts in this period.</li>}
              </ul>
            </div>
          </div>
        )}
      </div>
    </FeedFrame>
  );
};

const Sparkline: React.FC<{ series: FeedPageAnalytics['series'] }> = ({ series }) => {
  if (series.length < 2) return null;
  const w = 600, h = 120, pad = 6;
  const max = Math.max(1, ...series.map((s) => s.impressions));
  const pts = series.map((s, i) => {
    const x = pad + (i / (series.length - 1)) * (w - pad * 2);
    const y = h - pad - (s.impressions / max) * (h - pad * 2);
    return `${x},${y}`;
  });
  return (
    <div className="rounded-xl border border-border-light bg-card-light p-3 dark:border-border-dark/40 dark:bg-elevated-dark/40">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">Impressions per day</p>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-28 w-full" preserveAspectRatio="none">
        <polyline points={`${pad},${h - pad} ${pts.join(' ')} ${w - pad},${h - pad}`} fill="rgb(37 99 235 / 0.12)" stroke="none" />
        <polyline points={pts.join(' ')} fill="none" stroke="rgb(37 99 235)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
};

export { Users };
