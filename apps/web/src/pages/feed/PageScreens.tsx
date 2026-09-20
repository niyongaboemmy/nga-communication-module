import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  BadgeCheck, Bell, BellOff, Plus, BarChart3, ArrowLeft, Users, Search, X, Loader2, Settings2, Camera,
  Check, ChevronDown, MoreHorizontal, Mail, ExternalLink, Pencil, Link2, Trash2, UserPlus,
} from 'lucide-react';
import type {
  CreatePagePayload, FeedPageDetail, FeedPageEditor, FeedPageKind, FeedPageLink, FeedPageSummary,
  FeedPostView, FeedPageAnalytics, UpdatePageEditorPayload, UpdatePagePayload,
} from '@tupo/shared';
import { FEED_PAGE_KINDS, FEED_AUDIENCES, FEED_LIMITS } from '@tupo/shared';
import { Avatar, Badge, EmptyState, Spinner } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useNotify } from '../../context/NotificationContext';
import { apiGet } from '../../lib/api';
import { uploadFile, validateFile } from '../chat/uploads';
import { useFeed, useFeedList } from './FeedProvider';
import { FeedFrame, useFeedRails, PostSkeleton, PostCard, ReportDialog, EditPostMount } from './Frame';
import { Composer } from './Composer';
import { useDismiss, useMediaUrl } from './lib';
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
  // Same reasoning as Avatar: a `src` that fails mid-load must fall back to
  // `fallback` (initials, or the accent gradient), never sit there blank.
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  return (
    <div className={`group relative overflow-hidden ${shapeClass} ${className}`}>
      {src && !failed
        ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-cover" />
        : (fallback ?? <div className="h-full w-full bg-gradient-to-br from-blue-500 to-indigo-600" />)}
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

const PAGE_TABS = [
  { id: 'posts', label: 'Posts' },
  { id: 'about', label: 'About' },
  { id: 'team', label: 'Team' },
] as const;
type PageTab = (typeof PAGE_TABS)[number]['id'];

const MenuPanel: React.FC<{ children: React.ReactNode; align?: 'left' | 'right' }> = ({ children, align = 'right' }) => (
  <div role="menu" className={`animate-pop absolute top-full z-30 mt-1.5 w-60 rounded-xl bg-white p-1 shadow-[0_12px_28px_rgba(0,0,0,0.2)] ring-1 ring-black/5 dark:bg-elevated-dark dark:ring-white/10 ${align === 'right' ? 'right-0' : 'left-0'}`}>
    {children}
  </div>
);

const MenuRow: React.FC<{
  icon: React.ReactNode; label: string; hint?: string; onClick: () => void; danger?: boolean; disabled?: boolean;
}> = ({ icon, label, hint, onClick, danger, disabled }) => (
  <button
    role="menuitem" onClick={onClick} disabled={disabled}
    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[15px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
      danger ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20' : 'text-text-primary-light hover:bg-black/[0.05] dark:text-text-primary-dark dark:hover:bg-white/5'
    }`}
  >
    <span className="shrink-0 text-text-secondary-light dark:text-text-secondary-dark">{icon}</span>
    <span className="min-w-0 flex-1">
      {label}
      {hint && <span className="block text-xs font-normal text-text-secondary-light dark:text-text-secondary-dark">{hint}</span>}
    </span>
  </button>
);

/* Header controls share one pill language; sizes are separate strings so no
   two width/height utilities ever compete on the same element. */
const pill = 'inline-flex items-center justify-center gap-1.5 rounded-full font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60';
const pillMd = 'h-9 px-4 text-sm';
const pillSm = 'h-8 px-3 text-[13px]';
const pillIcon = 'h-9 w-9';
const secondaryTone = 'border border-border-light bg-white text-text-primary-light hover:bg-surface-light dark:border-border-dark/60 dark:bg-transparent dark:text-text-primary-dark dark:hover:bg-card-dark';
const primaryTone = 'bg-blue-600 text-white hover:bg-blue-700';
const secondaryButton = `${pill} ${pillMd} ${secondaryTone}`;
const primaryButton = `${pill} ${pillMd} ${primaryTone}`;
const smallPrimaryButton = `${pill} ${pillSm} ${primaryTone}`;

/**
 * Follow / Following. Once you follow, the button becomes a menu holding the
 * notification toggle and Unfollow — one control instead of a bell, a button
 * and an icon jostling for the same corner.
 */
const FollowControl: React.FC<{ page: FeedPageDetail; onFollow: () => void; onNotify: () => void }> = ({ page, onFollow, onNotify }) => {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  if (!page.following) {
    return <button onClick={onFollow} className={primaryButton}><Plus size={15} /> Follow</button>;
  }
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} className={secondaryButton}>
        {page.mandatory ? <BadgeCheck size={15} className="text-blue-500" /> : <Check size={15} />}
        {page.mandatory ? 'Required' : 'Following'}
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <MenuPanel>
          <MenuRow
            icon={page.notify ? <Bell size={16} /> : <BellOff size={16} />}
            label={page.notify ? 'Notifications on' : 'Notifications off'}
            hint={page.notify ? 'You are told about new posts' : 'New posts arrive quietly'}
            onClick={() => { onNotify(); close(); }}
          />
          {page.mandatory ? (
            <p className="px-2.5 py-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">This page is required for your role and cannot be unfollowed.</p>
          ) : (
            <MenuRow danger icon={<X size={16} />} label="Unfollow" onClick={() => { onFollow(); close(); }} />
          )}
        </MenuPanel>
      )}
    </div>
  );
};

/** The overflow menu: everything that is not the primary action. */
const PageMenu: React.FC<{ page: FeedPageDetail; canManage: boolean; onEdit: () => void }> = ({ page, canManage, onEdit }) => {
  const { confirm, notify } = useNotify();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} aria-label="More actions" aria-haspopup="menu" aria-expanded={open}
        className={`${pill} ${pillIcon} ${secondaryTone}`}>
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <MenuPanel>
          <MenuRow icon={<Link2 size={16} />} label="Copy page link" onClick={() => {
            close();
            navigator.clipboard.writeText(`${location.origin}/app/feed/p/${page.slug}`)
              .then(() => confirm('Link copied'))
              .catch(() => notify({ title: 'Could not copy the link', tone: 'error' }));
          }} />
          {page.myRole && <MenuRow icon={<BarChart3 size={16} />} label="Insights" hint="Reach, reactions and top posts" onClick={() => { close(); nav(`/app/feed/pages/${page.id}/insights`); }} />}
          {canManage && <MenuRow icon={<Pencil size={16} />} label="Edit page" onClick={() => { close(); onEdit(); }} />}
        </MenuPanel>
      )}
    </div>
  );
};

/** The quick-action buttons under the title — a registration form, a contact address. */
const QuickLinks: React.FC<{ links: FeedPageLink[]; accent: string }> = ({ links, accent }) => (
  <div className="flex flex-wrap gap-2">
    {links.map((l) => {
      const mail = l.url.toLowerCase().startsWith('mailto:');
      return (
        <a
          key={`${l.label}|${l.url}`} href={l.url}
          {...(mail ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
          className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors hover:brightness-95 dark:hover:brightness-125"
          style={{ borderColor: `${accent}55`, background: `${accent}14`, color: accent }}
        >
          {mail ? <Mail size={14} /> : <ExternalLink size={14} />}
          <span className="truncate">{l.label}</span>
        </a>
      );
    })}
  </div>
);

export const PageProfile: React.FC = () => {
  const { slug = '' } = useParams();
  const { posts, ingest } = useFeed();
  const { notify, confirm } = useNotify();
  const [page, setPage] = useState<FeedPageDetail | null>(null);
  const [tab, setTab] = useState<PageTab>('posts');
  const [allPages, setAllPages] = useState<FeedPageSummary[]>([]);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const cover = useMediaUrl(page?.coverFileId);
  const avatar = useMediaUrl(page?.avatarFileId);

  const reload = useCallback(() => { void api.getPage(slug).then(setPage); }, [slug]);
  useEffect(() => { reload(); void api.listPages().then(setAllPages); }, [reload]);

  const loader = useCallback((cursor?: string) => api.getPagePosts(page?.id ?? slug, { cursor }), [page?.id, slug]);
  const list = useFeedList(loader, [page?.id ?? slug]);
  // The server leads with pinned posts; keep that order true after a pin
  // toggles locally rather than waiting for a reload to move the card.
  const items = useMemo(() => list.ids
    .map((id) => posts[id]).filter((p): p is FeedPostView => Boolean(p))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || Date.parse(b.publishedAt ?? b.createdAt) - Date.parse(a.publishedAt ?? a.createdAt)),
  [list.ids, posts]);
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
    try {
      const updated = page.following ? await api.unfollowPage(page.id) : await api.followPage(page.id);
      setPage({ ...page, ...updated });
    } catch (e) {
      notify({ title: e instanceof Error ? e.message : 'Could not update your follow', tone: 'error' });
    }
  };
  const toggleNotify = async () => {
    try {
      await api.setPageNotify(page.id, !page.notify);
      setPage({ ...page, notify: !page.notify });
    } catch (e) {
      notify({ title: e instanceof Error ? e.message : 'Could not update notifications', tone: 'error' });
    }
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

  const stat = (value: number, label: string) => (
    <span className="inline-flex items-baseline gap-1">
      <span className="font-semibold tabular-nums text-text-primary-light dark:text-text-primary-dark">{value.toLocaleString()}</span>
      <span className="text-text-secondary-light dark:text-text-secondary-dark">{label}</span>
    </span>
  );

  return (
    <>
      <FeedFrame left={left} right={right}>
        <div className="mx-auto max-w-2xl">
          <Link to="/app/feed" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary-light hover:text-text-primary-light dark:text-text-secondary-dark">
            <ArrowLeft size={15} /> Back to feed
          </Link>

          <section className="overflow-hidden rounded-2xl border border-border-light bg-card-light shadow-sm dark:border-border-dark/40 dark:bg-elevated-dark/50">
            <BrandingImageButton
              shape="cover" src={cover} editable={canManage} busy={coverBusy} label="Change cover photo"
              onFile={(f) => void uploadBranding(f, 'coverFileId')}
              className="h-40 w-full sm:h-52"
              fallback={<div className="h-full w-full" style={{ background: `linear-gradient(130deg, ${page.accent}, #1e293b)` }} />}
            />
            <div className="px-4 pb-4 sm:px-5">
              {/*
               * The avatar sits half over the cover's bottom edge, inside a
               * solid card-coloured ring so the overlap reads as a deliberate
               * badge rather than a photo the banner happens to cut through.
               */}
              <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
                <div className="-mt-12 shrink-0 rounded-full bg-card-light p-1 shadow-md ring-1 ring-black/[0.08] dark:bg-elevated-dark dark:ring-white/10">
                  <BrandingImageButton
                    shape="circle" src={avatar} editable={canManage} busy={avatarBusy} label="Change page photo"
                    onFile={(f) => void uploadBranding(f, 'avatarFileId')}
                    className="h-24 w-24"
                    fallback={<Avatar name={page.name} size={96} />}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2 pb-1">
                  {canManage && (
                    <button onClick={() => setEditing(true)} className={secondaryButton}><Pencil size={14} /> Edit page</button>
                  )}
                  <FollowControl page={page} onFollow={() => void toggleFollow()} onNotify={() => void toggleNotify()} />
                  <PageMenu page={page} canManage={canManage} onEdit={() => setEditing(true)} />
                </div>
              </div>

              <div className="mt-3">
                <h1 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xl font-bold leading-tight text-text-primary-light dark:text-text-primary-dark sm:text-2xl">
                  {page.name}
                  {page.verified && <BadgeCheck size={20} className="shrink-0 text-blue-500" aria-label="Verified" />}
                </h1>
                {page.bio ? (
                  <p className="mt-1.5 whitespace-pre-wrap text-[15px] leading-snug text-text-primary-light/85 dark:text-text-primary-dark/85">{page.bio}</p>
                ) : canManage ? (
                  <button onClick={() => setEditing(true)} className="mt-1.5 text-[15px] font-medium text-blue-600 hover:underline dark:text-blue-400">
                    Add a short description of the page
                  </button>
                ) : null}
              </div>

              <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <Users size={15} className="text-text-secondary-light dark:text-text-secondary-dark" aria-hidden />
                {stat(page.followerCount, page.followerCount === 1 ? 'follower' : 'followers')}
                <span aria-hidden className="text-text-secondary-light/60 dark:text-text-secondary-dark/60">·</span>
                {stat(page.postCount, page.postCount === 1 ? 'post' : 'posts')}
                <span aria-hidden className="text-text-secondary-light/60 dark:text-text-secondary-dark/60">·</span>
                <span className="rounded-full bg-surface-light px-2 py-0.5 text-xs font-semibold capitalize text-text-secondary-light dark:bg-card-dark/60 dark:text-text-secondary-dark">{page.kind}</span>
              </p>

              {page.links.length > 0 ? (
                <div className="mt-3.5"><QuickLinks links={page.links} accent={page.accent} /></div>
              ) : canManage ? (
                <button onClick={() => setEditing(true)} className="mt-3.5 inline-flex items-center gap-1.5 rounded-full border border-dashed border-border-light px-3 py-1.5 text-[13px] font-semibold text-text-secondary-light transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-border-dark/60 dark:text-text-secondary-dark">
                  <Plus size={14} /> Add a link — registration form, email…
                </button>
              ) : null}
            </div>
          </section>

          <div role="tablist" aria-label="Page sections" className="mt-4 flex border-b border-border-light dark:border-border-dark/40">
            {PAGE_TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id} role="tab" aria-selected={active} onClick={() => setTab(t.id)}
                  className={`relative -mb-px px-4 py-2.5 text-[15px] font-semibold transition-colors ${
                    active ? 'text-blue-600 dark:text-blue-400' : 'text-text-secondary-light hover:text-text-primary-light dark:text-text-secondary-dark dark:hover:text-text-primary-dark'
                  }`}
                >
                  {t.label}
                  <span aria-hidden className={`absolute inset-x-2 bottom-0 h-[3px] rounded-t-full bg-blue-600 transition-opacity dark:bg-blue-400 ${active ? 'opacity-100' : 'opacity-0'}`} />
                </button>
              );
            })}
          </div>

          {tab === 'about' && <AboutTab page={page} canManage={canManage} onEdit={() => setEditing(true)} />}
          {tab === 'team' && <TeamTab page={page} canManage={canManage} onChanged={setPage} />}
          {tab === 'posts' && (
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
      {editing && <EditPageDialog page={page} onClose={() => setEditing(false)} onSaved={(p) => { setPage(p); setEditing(false); }} />}
    </>
  );
};

const AboutTab: React.FC<{ page: FeedPageDetail; canManage: boolean; onEdit: () => void }> = ({ page, canManage, onEdit }) => {
  const label = 'mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark';
  return (
    <div className="mt-4 space-y-5 rounded-2xl border border-border-light bg-card-light p-4 text-sm dark:border-border-dark/40 dark:bg-elevated-dark/40 sm:p-5">
      <div>
        <div className="flex items-center justify-between">
          <p className={label}>About</p>
          {canManage && <button onClick={onEdit} className="text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400">Edit</button>}
        </div>
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-text-primary-light dark:text-text-primary-dark">{page.bio || 'No description yet.'}</p>
      </div>
      {page.links.length > 0 && (
        <div>
          <p className={label}>Links</p>
          <ul className="space-y-1.5">
            {page.links.map((l) => (
              <li key={`${l.label}|${l.url}`} className="flex min-w-0 items-center gap-2">
                {l.url.toLowerCase().startsWith('mailto:') ? <Mail size={14} className="shrink-0 text-text-secondary-light" /> : <ExternalLink size={14} className="shrink-0 text-text-secondary-light" />}
                <a href={l.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-text-primary-light hover:underline dark:text-text-primary-dark">{l.label}</a>
                <span className="min-w-0 truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">{l.url.replace(/^mailto:/i, '')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className={label}>Details</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-text-primary-light dark:text-text-primary-dark">
          <dt className="text-text-secondary-light dark:text-text-secondary-dark">Type</dt><dd className="capitalize">{page.kind}</dd>
          <dt className="text-text-secondary-light dark:text-text-secondary-dark">Audience</dt><dd className="capitalize">{page.audience}</dd>
          <dt className="text-text-secondary-light dark:text-text-secondary-dark">Created</dt><dd>{new Date(page.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</dd>
          <dt className="text-text-secondary-light dark:text-text-secondary-dark">Team</dt><dd>{page.editors.length} {page.editors.length === 1 ? 'member' : 'members'}</dd>
        </dl>
      </div>
    </div>
  );
};

/* ── Team ──────────────────────────────────────────────────────────────── */

const RoleChip: React.FC<{ role: FeedPageEditor['role'] }> = ({ role }) => (
  <Badge tone={role === 'owner' ? 'blue' : 'slate'}>{role === 'owner' ? 'Owner' : 'Editor'}</Badge>
);

/** "President", "Patron" — tinted with the page's accent so it reads as the page's own label. */
const TitleBadge: React.FC<{ title: string; accent: string }> = ({ title, accent }) => (
  <span className="inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs font-semibold" style={{ borderColor: `${accent}55`, background: `${accent}14`, color: accent }}>
    <span className="truncate">{title}</span>
  </span>
);

const TeamTab: React.FC<{ page: FeedPageDetail; canManage: boolean; onChanged: (p: FeedPageDetail) => void }> = ({ page, canManage, onChanged }) => {
  const { notify, confirm } = useNotify();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const run = async (what: () => Promise<FeedPageDetail>, success: string) => {
    try { onChanged(await what()); confirm(success); return true; }
    catch (e) { notify({ title: e instanceof Error ? e.message : 'That did not work', tone: 'error' }); return false; }
  };

  const remove = (member: FeedPageEditor) => {
    if (!window.confirm(`Remove ${member.name} from the page team?`)) return;
    void run(() => api.removeEditor(page.id, member.id), `${member.name} removed`);
  };

  return (
    <div className="mt-4 rounded-2xl border border-border-light bg-card-light p-4 text-sm dark:border-border-dark/40 dark:bg-elevated-dark/40 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">Team</p>
          <p className="mt-0.5 text-xs text-text-secondary-light dark:text-text-secondary-dark">The people who run this page and post as it.</p>
        </div>
        {canManage && (
          <button onClick={() => setAdding(true)} className={smallPrimaryButton}><UserPlus size={14} /> Add member</button>
        )}
      </div>
      <ul className="divide-y divide-border-light dark:divide-border-dark/40">
        {page.editors.map((m) => (
          <li key={m.id} className="py-2.5">
            {editingId === m.id ? (
              <EditMemberRow
                member={m} page={page}
                onCancel={() => setEditingId(null)}
                onSave={async (patch) => { if (await run(() => api.updateEditor(page.id, m.id, patch), 'Team updated')) setEditingId(null); }}
              />
            ) : (
              <div className="flex items-center gap-3">
                <Avatar name={m.name} src={m.avatarUrl ?? undefined} size={40} tintKey={m.id} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold text-text-primary-light dark:text-text-primary-dark">{m.name}</span>
                    {m.title && <TitleBadge title={m.title} accent={page.accent} />}
                  </p>
                  <p className="mt-0.5"><RoleChip role={m.role} /></p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button onClick={() => setEditingId(m.id)} aria-label={`Edit ${m.name}`} title="Edit title or role" className="grid h-8 w-8 place-items-center rounded-full text-text-secondary-light hover:bg-surface-light hover:text-text-primary-light dark:hover:bg-card-dark"><Pencil size={15} /></button>
                    <button onClick={() => remove(m)} aria-label={`Remove ${m.name}`} title="Remove from team" className="grid h-8 w-8 place-items-center rounded-full text-text-secondary-light hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"><Trash2 size={15} /></button>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {page.editors.length === 0 && <EmptyState title="No team yet" hint={canManage ? 'Add the people who run this page.' : undefined} />}
      {adding && (
        <AddMemberDialog
          page={page}
          onClose={() => setAdding(false)}
          onAdd={async (userId, role, title) => { if (await run(() => api.addEditor(page.id, userId, role, title), 'Added to the team')) setAdding(false); }}
        />
      )}
    </div>
  );
};

const fieldClass = 'w-full rounded-lg border border-border-light bg-surface-light px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-border-dark/60 dark:bg-card-dark/50';

const RoleSelect: React.FC<{ value: FeedPageEditor['role']; onChange: (r: FeedPageEditor['role']) => void }> = ({ value, onChange }) => (
  <select value={value} onChange={(e) => onChange(e.target.value === 'owner' ? 'owner' : 'editor')} className={`${fieldClass} w-auto`}>
    <option value="editor" className="dark:bg-elevated-dark">Editor — can post</option>
    <option value="owner" className="dark:bg-elevated-dark">Owner — can manage</option>
  </select>
);

const EditMemberRow: React.FC<{
  member: FeedPageEditor; page: FeedPageDetail;
  onCancel: () => void; onSave: (patch: UpdatePageEditorPayload) => Promise<void>;
}> = ({ member, onCancel, onSave }) => {
  const [title, setTitle] = useState(member.title);
  const [role, setRole] = useState(member.role);
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await onSave({ title, role }); } finally { setBusy(false); } };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Avatar name={member.name} src={member.avatarUrl ?? undefined} size={40} tintKey={member.id} />
      <span className="mr-1 font-semibold text-text-primary-light dark:text-text-primary-dark">{member.name}</span>
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={FEED_LIMITS.EDITOR_TITLE_MAX} placeholder="Title, e.g. President" autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') onCancel(); }}
        className={`${fieldClass} w-44`} />
      <RoleSelect value={role} onChange={setRole} />
      <div className="ml-auto flex items-center gap-1">
        <button onClick={onCancel} className="rounded-full px-3 py-1.5 text-sm text-text-secondary-light dark:text-text-secondary-dark">Cancel</button>
        <button onClick={() => void save()} disabled={busy} className={smallPrimaryButton}>{busy && <Loader2 size={13} className="animate-spin" />} Save</button>
      </div>
    </div>
  );
};

interface DirectoryPerson { id: string; name: string; avatarUrl: string | null; role: string; email: string; }

const AddMemberDialog: React.FC<{
  page: FeedPageDetail; onClose: () => void;
  onAdd: (userId: string, role: FeedPageEditor['role'], title: string) => Promise<void>;
}> = ({ page, onClose, onAdd }) => {
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<DirectoryPerson | null>(null);
  const [title, setTitle] = useState('');
  const [role, setRole] = useState<FeedPageEditor['role']>('editor');
  const [busy, setBusy] = useState(false);

  // Debounced, same shape as the chat pickers — a request per keystroke is a request per keystroke.
  useEffect(() => {
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      apiGet<{ people: DirectoryPerson[] }>(`/api/chat/directory?q=${encodeURIComponent(query)}`)
        .then((r) => { if (!cancelled) setPeople(r.data!.people); })
        .catch(() => { if (!cancelled) setPeople([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  const already = useMemo(() => new Set(page.editors.map((e) => e.id)), [page.editors]);
  const candidates = people.filter((p) => !already.has(p.id));

  const submit = async () => {
    if (!picked) return;
    setBusy(true);
    try { await onAdd(picked.id, role, title); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md animate-pop overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl dark:border-border-dark/50 dark:bg-elevated-dark" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark"><UserPlus size={15} /> Add to the team</h2>
          <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-text-secondary-light hover:bg-surface-light dark:hover:bg-card-dark"><X size={18} /></button>
        </div>
        <div className="space-y-3 px-5 pb-5 pt-3">
          {picked ? (
            <div className="flex items-center gap-3 rounded-xl border border-border-light bg-surface-light p-2.5 dark:border-border-dark/60 dark:bg-card-dark/40">
              <Avatar name={picked.name} src={picked.avatarUrl ?? undefined} size={36} tintKey={picked.id} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">{picked.name}</p>
                <p className="truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">{picked.email}</p>
              </div>
              <button onClick={() => setPicked(null)} className="text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400">Change</button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-full border border-border-light bg-surface-light px-3 py-2 dark:border-border-dark/60 dark:bg-card-dark/50">
                <Search size={15} className="text-text-secondary-light" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search people by name or email" autoFocus className="flex-1 bg-transparent text-sm outline-none" />
                {searching && <Loader2 size={14} className="animate-spin text-text-secondary-light" />}
              </div>
              <ul className="max-h-56 overflow-y-auto rounded-xl border border-border-light dark:border-border-dark/50">
                {candidates.map((p) => (
                  <li key={p.id}>
                    <button onClick={() => setPicked(p)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-light dark:hover:bg-card-dark/50">
                      <Avatar name={p.name} src={p.avatarUrl ?? undefined} size={32} tintKey={p.id} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-text-primary-light dark:text-text-primary-dark">{p.name}</span>
                        <span className="block truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">{p.email}</span>
                      </span>
                    </button>
                  </li>
                ))}
                {!searching && candidates.length === 0 && <li className="px-3 py-4 text-center text-xs text-text-secondary-light dark:text-text-secondary-dark">No one found.</li>}
              </ul>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={FEED_LIMITS.EDITOR_TITLE_MAX} placeholder="Title (optional), e.g. President" className={`${fieldClass} min-w-0 flex-1`} />
            <RoleSelect value={role} onChange={setRole} />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border-light px-5 py-3 dark:border-border-dark/40">
          <button onClick={onClose} className="rounded-full px-3 py-1.5 text-sm text-text-secondary-light dark:text-text-secondary-dark">Cancel</button>
          <button onClick={() => void submit()} disabled={!picked || busy} className={primaryButton}>
            {busy && <Loader2 size={13} className="animate-spin" />} Add
          </button>
        </div>
      </div>
    </div>
  );
};

/* ── Edit page ─────────────────────────────────────────────────────────── */

const EditPageDialog: React.FC<{ page: FeedPageDetail; onClose: () => void; onSaved: (p: FeedPageDetail) => void }> = ({ page, onClose, onSaved }) => {
  const [form, setForm] = useState<Required<Pick<UpdatePagePayload, 'name' | 'bio' | 'kind' | 'audience' | 'accent' | 'links'>>>({
    name: page.name, bio: page.bio, kind: page.kind, audience: page.audience, accent: page.accent,
    links: page.links.map((l) => ({ ...l })),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setLink = (i: number, patch: Partial<FeedPageLink>) =>
    setForm((f) => ({ ...f, links: f.links.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const removeLink = (i: number) => setForm((f) => ({ ...f, links: f.links.filter((_, j) => j !== i) }));
  const addLink = () => setForm((f) => ({ ...f, links: [...f.links, { label: '', url: '' }] }));

  const submit = async () => {
    if (form.name.trim().length < 2) { setErr('A page needs a name.'); return; }
    // A blank row is nothing to save; a half-filled one is a mistake to hear about.
    const links = form.links.filter((l) => l.label.trim() || l.url.trim());
    setBusy(true); setErr(null);
    try {
      onSaved(await api.updatePage(page.id, {
        name: form.name.trim(), bio: form.bio, kind: form.kind, audience: form.audience, accent: form.accent,
        links: links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
      }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the page.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-labelledby="edit-page-title" className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg animate-pop flex-col overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl dark:border-border-dark/50 dark:bg-elevated-dark" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 id="edit-page-title" className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark"><Settings2 size={15} /> Edit page</h2>
          <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-text-secondary-light hover:bg-surface-light dark:hover:bg-card-dark"><X size={18} /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-4 pt-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-text-secondary-light dark:text-text-secondary-dark">Name</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus className={fieldClass} />
          </label>
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-xs font-semibold text-text-secondary-light dark:text-text-secondary-dark">
              Description <span className="font-normal tabular-nums">{form.bio.length}/{FEED_LIMITS.PAGE_BIO_MAX}</span>
            </span>
            <textarea value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value.slice(0, FEED_LIMITS.PAGE_BIO_MAX) })} rows={3} placeholder="What is this page about? Who is it for?"
              className={`${fieldClass} resize-none`} />
          </label>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold text-text-secondary-light dark:text-text-secondary-dark">Quick links</span>
              <span className="text-xs text-text-secondary-light dark:text-text-secondary-dark">{form.links.length}/{FEED_LIMITS.PAGE_LINKS_MAX}</span>
            </div>
            <p className="mb-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">Buttons under the page title — a registration form, a contact address. Web links or <code>mailto:</code> addresses.</p>
            <div className="space-y-2">
              {form.links.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <input value={l.label} onChange={(e) => setLink(i, { label: e.target.value })} maxLength={FEED_LIMITS.PAGE_LINK_LABEL_MAX} placeholder="Label" aria-label={`Link ${i + 1} label`} className={`${fieldClass} w-2/5`} />
                  <input value={l.url} onChange={(e) => setLink(i, { url: e.target.value })} maxLength={FEED_LIMITS.PAGE_LINK_URL_MAX} placeholder="https://… or mailto:…" aria-label={`Link ${i + 1} address`} className={`${fieldClass} min-w-0 flex-1`} />
                  <button onClick={() => removeLink(i)} aria-label={`Remove link ${i + 1}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-text-secondary-light hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"><Trash2 size={15} /></button>
                </div>
              ))}
              {form.links.length < FEED_LIMITS.PAGE_LINKS_MAX && (
                <button onClick={addLink} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-blue-600 hover:underline dark:text-blue-400"><Plus size={14} /> Add link</button>
              )}
            </div>
          </div>

          <div className="flex gap-2">
            <label className="flex-1">
              <span className="mb-1 block text-xs font-semibold text-text-secondary-light dark:text-text-secondary-dark">Type</span>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as FeedPageKind })} className={`${fieldClass} capitalize`}>
                {FEED_PAGE_KINDS.map((k) => <option key={k} value={k} className="capitalize dark:bg-elevated-dark">{k}</option>)}
              </select>
            </label>
            <label className="flex-1">
              <span className="mb-1 block text-xs font-semibold text-text-secondary-light dark:text-text-secondary-dark">Audience</span>
              <select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as FeedPageDetail['audience'] })} className={`${fieldClass} capitalize`}>
                {FEED_AUDIENCES.map((a) => <option key={a} value={a} className="capitalize dark:bg-elevated-dark">{a}</option>)}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-xs font-semibold text-text-secondary-light dark:text-text-secondary-dark">Accent</span>
              <input type="color" value={form.accent} onChange={(e) => setForm({ ...form, accent: e.target.value })} aria-label="Accent colour" className="h-10 w-12 rounded-lg border border-border-light dark:border-border-dark/60" />
            </label>
          </div>
          {err && <p className="text-xs font-medium text-red-600 dark:text-red-400">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border-light px-5 py-3 dark:border-border-dark/40">
          <button onClick={onClose} className="rounded-full px-3 py-1.5 text-sm text-text-secondary-light dark:text-text-secondary-dark">Cancel</button>
          <button onClick={() => void submit()} disabled={busy || form.name.trim().length < 2} className={primaryButton}>
            {busy && <Loader2 size={13} className="animate-spin" />} Save
          </button>
        </div>
      </div>
    </div>
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
