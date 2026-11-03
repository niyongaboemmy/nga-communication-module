import React, { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  LogOut, Sun, Moon, Search, MoreHorizontal, Command, Settings as SettingsIcon,
} from 'lucide-react';
import { Logo } from '../components/Logo';
import { useAuth } from '../context/AuthContext';
import { usePermissions } from '../hooks/usePermissions';
import { Avatar, IconButton, UnreadBadge } from '../components/ui';
import { avatarPreviewOpen } from '../components/AvatarPreview';
import { AppsSwitcher } from '../components/shell/AppsSwitcher';
import { MODULES, ADMIN, type NavEntry } from '../components/shell/navigation';
import { ConnectionBanner, useConnectionStatus } from '../components/shell/ConnectionBanner';
import { NotificationBell } from '../components/shell/NotificationCenter';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { UpdateNotice } from '../pwa/UpdateNotice';
import { GlobalSearch } from '../components/GlobalSearch';
import { usePresenceReporter } from '../hooks/usePresenceReporter';
import { useModuleBadges } from '../hooks/useModuleBadges';
import { preloadRoute, preloadWhenIdle } from '../lib/lazyPage';
import { toPresence } from './chat/types';
import { StatusPicker } from './Settings';
import type { Presence } from './chat/types';

/**
 * The Tupo application frame.
 *
 * Two things are true at once and the layout has to satisfy both:
 *
 *  1. It must read as an NGA app. So the top bar is the MIS/TaskMentor bar —
 *     64px, translucent with a backdrop blur, waffle and logo on the left,
 *     theme toggle and avatar on the right.
 *
 *  2. It is a chat client, not a records app. So beneath that bar sits a narrow
 *     icon rail rather than the MIS's 256px labelled sidebar: the horizontal
 *     budget belongs to the conversation list and the message thread, and every
 *     serious messenger spends it that way.
 *
 * The frame is a flex column at exactly viewport height (`h-app` resolves to
 * `100dvh`), not a `fixed` bar with a `pt-16` body. Chat panes need a real
 * height to scroll independently, and a fixed bar would leave them measuring
 * against the document instead.
 *
 * Breakpoints:
 *   < 768px   rail becomes a bottom tab bar; panes are shown one at a time
 *   ≥ 768px   rail appears; conversation list and thread share the width
 *   ≥ 1280px  the context panel can sit inline instead of overlaying
 */

/* ------------------------------------------------------------------ *
 * Rail (tablet and desktop)
 * ------------------------------------------------------------------ */

/**
 * While a screen's code downloads: a thin progress bar at the top, shown only
 * after 150 ms so a preloaded module never flashes it.
 */
const ScreenLoading: React.FC = () => {
  const [show, setShow] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setShow(true), 150); return () => window.clearTimeout(t); }, []);
  if (!show) return null;
  return (
    <div role="progressbar" aria-label="Loading" className="h-0.5 w-full overflow-hidden bg-blue-100 dark:bg-blue-900/30">
      <div className="h-full w-1/3 animate-[tupo-indeterminate_1s_ease-in-out_infinite] bg-blue-600" />
    </div>
  );
};

const RailLink: React.FC<{ entry: NavEntry; badge?: number }> = ({ entry, badge }) => {
  const { icon: Icon, to, label } = entry;
  return (
    <NavLink
      to={to}
      title={label}
      onMouseEnter={() => preloadRoute(to)}
      onFocus={() => preloadRoute(to)}
      className={({ isActive }) =>
        `group relative grid h-11 w-11 place-items-center rounded-xl transition-colors duration-150 ` +
        (isActive
          ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
          : 'text-text-secondary-light hover:bg-surface-light hover:text-text-primary-light ' +
            'dark:text-text-secondary-dark/80 dark:hover:bg-surface-dark dark:hover:text-text-primary-dark')
      }
    >
      {({ isActive }) => (
        <>
          {/* The active marker is a rail-edge bar, not just a tint: at 44px the
              tint alone is easy to miss against a dark rail. */}
          <span
            aria-hidden="true"
            className={`absolute -left-2.5 h-6 w-1 rounded-r-full bg-blue-600 transition-all duration-150 dark:bg-blue-500 ${
              isActive ? 'opacity-100' : 'opacity-0'
            }`}
          />
          <Icon size={20} strokeWidth={isActive ? 2.2 : 1.8} />
          {badge ? (
            <span className="absolute -right-0.5 -top-0.5">
              <UnreadBadge count={badge} />
            </span>
          ) : null}

          {/* Tooltip — the rail has no labels, so hovering must name the icon.
              `hidden` on touch widths where hover does not exist. */}
          <span
            role="tooltip"
            className="pointer-events-none absolute left-full z-60 ml-3 hidden whitespace-nowrap rounded-lg bg-slate-900 px-2 py-1 text-xs font-medium text-white opacity-0  transition-opacity duration-150 group-hover:opacity-100 md:block dark:bg-card-dark"
          >
            {label}
          </span>
        </>
      )}
    </NavLink>
  );
};

const Rail: React.FC<{ modules: NavEntry[]; admin: NavEntry[]; badges: Record<string, number> }> = ({ modules, admin, badges }) => (
  <nav
    aria-label="Modules"
    className="relative z-30 hidden w-16 shrink-0 flex-col items-center gap-1.5 border-r border-border-light bg-white py-3 md:flex dark:border-border-dark/30 dark:bg-chrome-dark"
  >
    {modules.map((entry) => <RailLink key={entry.to} entry={entry} badge={badges[entry.to]} />)}

    {admin.length > 0 && (
      <>
        <div className="my-1.5 h-px w-7 bg-border-light dark:bg-card-dark/50" />
        {admin.map((entry) => <RailLink key={entry.to} entry={entry} />)}
      </>
    )}
  </nav>
);

/* ------------------------------------------------------------------ *
 * Bottom tab bar (mobile)
 * ------------------------------------------------------------------ */

const TabLink: React.FC<{ entry: NavEntry; badge?: number }> = ({ entry, badge }) => {
  const { icon: Icon, to, label } = entry;
  return (
    <NavLink
      to={to}
      onTouchStart={() => preloadRoute(to)}
      className={({ isActive }) =>
        `relative flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-[10px] font-medium transition-colors duration-150 ` +
        (isActive
          ? 'text-blue-600 dark:text-blue-400'
          : 'text-text-secondary-light dark:text-text-secondary-dark/80')
      }
    >
      {({ isActive }) => (
        <>
          <span className="relative">
            <Icon size={21} strokeWidth={isActive ? 2.2 : 1.8} />
            {badge ? (
              <span className="absolute -right-2 -top-1.5"><UnreadBadge count={badge} /></span>
            ) : null}
          </span>
          <span>{label}</span>
        </>
      )}
    </NavLink>
  );
};

/**
 * Mobile navigation. Four tabs plus "More" — past five, targets fall under the
 * 44px minimum on a 360px-wide phone, so the overflow goes into a sheet rather
 * than getting squeezed.
 */
const BottomTabs: React.FC<{ modules: NavEntry[]; admin: NavEntry[]; badges: Record<string, number> }> = ({ modules, admin, badges }) => {
  const [sheetOpen, setSheetOpen] = useState(false);
  const location = useLocation();

  useEffect(() => { setSheetOpen(false); }, [location.pathname]);
  // Escape closes the sheet, like every other dialog.
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheetOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheetOpen]);

  const primary = modules.slice(0, 4);
  const overflow = [...modules.slice(4), ...admin];
  // Mail lives under "More" on a phone; its count must not vanish with it.
  const overflowBadge = overflow.reduce((n, e) => n + (badges[e.to] ?? 0), 0);

  return (
    <>
      <nav
        aria-label="Modules"
        className="pb-safe relative z-30 flex shrink-0 items-stretch gap-0.5 border-t border-border-light bg-white/95 px-1.5 pt-1 backdrop-blur-md md:hidden dark:border-border-dark/40 dark:bg-chrome-dark/90"
      >
        {primary.map((entry) => <TabLink key={entry.to} entry={entry} badge={badges[entry.to]} />)}
        {overflow.length > 0 && (
          <button
            onClick={() => setSheetOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            aria-label={overflowBadge > 0 ? `More, ${overflowBadge} unread` : 'More'}
            className="flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-[10px] font-medium text-text-secondary-light dark:text-text-secondary-dark/80"
          >
            <span className="relative">
              <MoreHorizontal size={21} strokeWidth={1.8} />
              {overflowBadge > 0 && (
                <span className="absolute -right-2 -top-1.5"><UnreadBadge count={overflowBadge} /></span>
              )}
            </span>
            More
          </button>
        )}
      </nav>

      {sheetOpen && (
        <div className="fixed inset-0 z-80 md:hidden" role="dialog" aria-modal="true" aria-label="More">
          <div className="absolute inset-0 bg-black/40" onClick={() => setSheetOpen(false)} />
          <div className="pb-safe animate-fade-in absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-border-light bg-white p-3 dark:border-border-dark/40 dark:bg-elevated-dark">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300 dark:bg-border-dark" />
            <div className="grid grid-cols-4 gap-1">
              {overflow.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  className="flex flex-col items-center gap-2 rounded-2xl px-1 py-3 text-center text-[11px] font-medium text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-surface-dark"
                >
                  <span className="relative grid h-11 w-11 place-items-center rounded-2xl bg-surface-light text-text-secondary-light dark:bg-card-dark/50 dark:text-text-secondary-dark">
                    <Icon size={20} />
                    {(badges[to] ?? 0) > 0 && (
                      <span className="absolute -right-1.5 -top-1.5"><UnreadBadge count={badges[to]!} /></span>
                    )}
                  </span>
                  <span className="leading-tight">{label}</span>
                </NavLink>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

/* ------------------------------------------------------------------ *
 * Top bar
 * ------------------------------------------------------------------ */

const UserMenu: React.FC<{ presence: Presence }> = ({ presence }) => {
  const { user, signOut } = useAuth();
  const { roleName } = usePermissions();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (avatarPreviewOpen()) return; // clicks in the photo preview belong to it
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !avatarPreviewOpen()) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Account menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-xl p-1 transition-colors duration-150 hover:bg-surface-light dark:hover:bg-surface-dark"
      >
        <Avatar name={user.name} src={user.avatarUrl} size={32} presence={presence} />
        {/* The name is dropped below `lg` — on a phone the avatar alone is the
            affordance, and the width belongs to the conversation. */}
        <span className="hidden max-w-[10rem] flex-col items-start leading-tight lg:flex">
          <span className="truncate text-xs font-semibold text-text-primary-light dark:text-text-primary-dark">
            {user.name}
          </span>
          {roleName && (
            <span className="truncate text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
              {roleName}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="animate-pop absolute right-0 z-60 mt-2 w-60 origin-top-right rounded-2xl border border-border-light bg-white p-1.5   dark:border-border-dark/50 dark:bg-elevated-dark dark:"
        >
          <div className="flex items-center gap-3 rounded-xl px-2.5 py-2.5">
            <Avatar name={user.name} src={user.avatarUrl} size={38} preview previewCaption={roleName ?? undefined} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
                {user.name}
              </p>
              <p className="truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">
                {user.email || roleName}
              </p>
            </div>
          </div>
          <div className="my-1 h-px bg-border-light dark:bg-card-dark/50" />
          <p className="px-2.5 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
            Status
          </p>
          <StatusPicker compact onPicked={() => setOpen(false)} />
          <div className="my-1 h-px bg-border-light dark:bg-card-dark/50" />
          <NavLink
            role="menuitem"
            to="/app/settings"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-sm font-medium text-text-primary-light transition-colors duration-150 hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-surface-dark"
          >
            <SettingsIcon size={15} /> Settings
          </NavLink>
          <button
            role="menuitem"
            onClick={signOut}
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-sm font-medium text-red-600 transition-colors duration-150 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            <LogOut size={15} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
};

const TopBar: React.FC<{ onOpenSearch: () => void; myPresence: Presence }> = ({ onOpenSearch, myPresence }) => {
  const { theme, toggleTheme } = useAuth();

  return (
    <header
      role="banner"
      /* `relative z-50` is what puts the whole top bar — and every menu that
         hangs off it — above the panes below. The thread header and the
         conversation list both use backdrop-blur, which creates a stacking
         context; without this the later sibling would paint over the menus. */
      className="relative z-50 flex h-16 shrink-0 items-center justify-between gap-2 border-b border-border-light/70 bg-white/80 px-3 backdrop-blur-md sm:px-4 dark:border-border-dark/40 dark:bg-chrome-dark/80"
    >
      {/* Left cluster — waffle then logo, identical to the MIS and TaskMentor. */}
      <div className="flex min-w-0 items-center gap-1 sm:gap-2">
        <AppsSwitcher />
        <NavLink to="/app" className="flex items-center gap-2 rounded-xl px-1 py-1">
          <Logo size={26} />
          <span className="text-base font-bold tracking-tight text-text-primary-light dark:text-text-primary-dark">
            Tupo
          </span>
        </NavLink>
      </div>

      {/* Centre — the ⌘K entry point from SRS §15.1. It is a button, not an
          input: the real surface is a command palette, and a fake input that
          steals focus on a phone is a trap. */}
      <button
        onClick={onOpenSearch}
        className="hidden max-w-md flex-1 items-center gap-2 rounded-xl border border-border-light bg-surface-light px-3 py-2 text-sm text-text-secondary-light transition-colors duration-150 hover:border-blue-300 hover:bg-white md:flex dark:border-border-dark/50 dark:bg-chrome-dark/70 dark:text-text-secondary-dark dark:hover:border-blue-800 dark:hover:bg-chrome-dark"
      >
        <Search size={15} />
        <span className="flex-1 text-left">Search people, channels and messages</span>
        <kbd className="hidden items-center gap-0.5 rounded-md border border-border-light bg-white px-1.5 py-0.5 font-sans text-[10px] font-semibold text-text-secondary-light lg:flex dark:border-border-dark dark:bg-card-dark dark:text-text-secondary-dark">
          <Command size={9} />K
        </kbd>
      </button>

      <div className="flex items-center gap-0.5 sm:gap-1.5">
        <IconButton label="Search" className="md:hidden" onClick={onOpenSearch}>
          <Search size={18} />
        </IconButton>

        <NotificationBell />

        <IconButton label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggleTheme}>
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </IconButton>

        <div className="mx-1 hidden h-6 w-px bg-border-light sm:block dark:bg-card-dark/60" />
        <UserMenu presence={myPresence} />
      </div>
    </header>
  );
};

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

export const AppShell: React.FC = () => {
  const { can } = usePermissions();
  const location = useLocation();
  const connection = useConnectionStatus();
  const [searchOpen, setSearchOpen] = useState(false);
  // Reports idle/away for this tab, and gives the own-avatar dot something
  // truthful to show instead of a hardcoded green.
  const myPresence = usePresenceReporter();

  /*
   * ⌘K anywhere in the shell.
   *
   * Ignored while a text field has focus unless the modifier is held, so
   * typing "k" into a message composer does not open a search box. Chat's own
   * palette used to own this chord; it now defers to this one, which searches
   * conversations too and a great deal besides.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Plain Ctrl/⌘ K only: with Shift it is the chat command palette's, and
      // opening both meant one Enter ran both — the search's navigation then
      // closed the conversation the palette was acting on.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const modules = MODULES.filter((i) => can(i.perm));
  const admin = ADMIN.filter((i) => can(i.perm));

  // Once the shell is up, fetch the code of the other modules this person can
  // open, in rail order, while the browser is idle (P-01).
  const preloadKey = modules.map((m) => m.to).join(',');
  useEffect(() => {
    if (preloadKey) preloadWhenIdle(preloadKey.split(','));
  }, [preloadKey]);
  const badges = useModuleBadges();

  return (
    <div className="h-app flex flex-col overflow-hidden bg-background-light text-text-primary-light dark:bg-background-dark dark:text-text-primary-dark">
      <TopBar onOpenSearch={() => setSearchOpen(true)} myPresence={toPresence(myPresence)} />
      <ConnectionBanner status={connection} />
      <UpdateNotice />
      {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}

      <div className="flex min-h-0 flex-1">
        <Rail modules={modules} admin={admin} badges={badges} />

        {/* Pages own their own scrolling. Chat sizes itself to `h-full` and
            never overflows this container; the admin pages are ordinary
            documents and scroll here. */}
        <main data-app-scroll className="min-w-0 flex-1 overflow-y-auto bg-surface-light dark:bg-background-dark">
          {/* One broken screen must not take the shell with it (F-06); moving
              to another screen clears the error. */}
          <ErrorBoundary resetKey={location.pathname} label="this screen">
            {/* A module's code loads on first visit (P-01); the shell stays put. */}
            <React.Suspense fallback={<ScreenLoading />}>
              <Outlet />
            </React.Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <BottomTabs modules={modules} admin={admin} badges={badges} />
    </div>
  );
};

export const ComingSoon: React.FC<{ module: string; phase: string }> = ({ module, phase }) => (
  <div className="grid h-full place-items-center p-8 text-center">
    <div>
      <h2 className="text-base font-semibold text-text-primary-light dark:text-text-primary-dark">{module}</h2>
      <p className="mt-1 text-sm text-text-secondary-light dark:text-text-secondary-dark">Arrives in {phase}.</p>
    </div>
  </div>
);
