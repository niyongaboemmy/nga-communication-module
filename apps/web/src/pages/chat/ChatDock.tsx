import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, Maximize2, MessageSquare, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useMeetCall } from '../../context/MeetCallContext';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { useChat } from './ChatProvider';
import { ConversationList } from './ConversationList';
import { MessageThread } from './MessageThread';
import { Composer } from './Composer';

/**
 * The chat dock — a launcher that follows you around the app.
 *
 * Chat is the thing people are interrupted by, and until now the only way to
 * answer was to navigate to /app/chat and lose whatever you were doing. The
 * notification bridge already reaches every page; this gives that notification
 * somewhere to go.
 *
 * It is a *shell*, deliberately. The list, the thread and the composer are the
 * same components the full page uses, so unfurled links, translations, threads,
 * uploads and the windowed message log all behave identically in here — and a
 * fix to any of them lands in both places at once. What the dock adds is
 * framing: where it sits, when it appears, and how you get out of it.
 */

/** Routes that must never show it, and why. */
function suppressedOn(pathname: string): boolean {
  // The chat page *is* the chat, so a floating shortcut to it is noise.
  if (pathname.startsWith('/app/chat')) return true;
  /*
   * Meet, both the in-app route and the guest one. A meeting already has its
   * own chat panel scoped to the room, and a second, different chat floating
   * over a call is a way to send a message to the wrong place. The screen is
   * also the busiest in the app — it has the call controls and MiniCall.
   */
  if (pathname.startsWith('/app/meet') || pathname.startsWith('/meet/')) return true;
  return false;
}

const DockInner: React.FC = () => {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { shouldShowMini } = useMeetCall();
  const {
    conversations, activeId, setActiveId, active, connected,
  } = useChat();

  const [open, setOpen] = useState(false);
  /** Drives the badge's attention pulse — see the effect below. */
  const [pulse, setPulse] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);

  const { unread, mentions } = useMemo(() => conversations.reduce(
    (acc, c) => ({
      unread: acc.unread + c.unread,
      mentions: acc.mentions + c.unreadMentions,
    }),
    { unread: 0, mentions: 0 },
  ), [conversations]);

  /*
   * Pulse when the count *rises*, not whenever it is non-zero. A badge that
   * animates forever is wallpaper; one that moves when something arrives is
   * information. Reading messages lowers the count and must stay silent.
   */
  const prevUnread = useRef(unread);
  useEffect(() => {
    if (unread > prevUnread.current && !open) {
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 1600);
      prevUnread.current = unread;
      return () => clearTimeout(t);
    }
    prevUnread.current = unread;
  }, [unread, open]);

  const close = useCallback(() => {
    setOpen(false);
    // Focus goes back to the control that opened it, or a keyboard user is
    // dropped at the top of the document.
    launcherRef.current?.focus();
  }, []);

  /* Close on Escape; ⌘/Ctrl+⇧+M toggles. Chosen because ⌘K, ⌘F and ⌘⇧S are
     already bound inside the chat page and a global would shadow them. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        const target = e.target as HTMLElement | null;
        // Inside the composer, Escape belongs to the composer (it drops a
        // quote-reply). Only close the dock when it would otherwise do nothing.
        if (target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT') return;
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  /* Click outside closes. Pointerdown rather than click, so a drag that starts
     inside and ends outside does not count as leaving. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || launcherRef.current?.contains(t)) return;
      // A dialog opened *from* the dock (emoji picker, forward, uploads) is
      // portalled elsewhere in the DOM; closing under it would be wrong.
      if ((t as HTMLElement).closest?.('[role="dialog"], [role="listbox"], [role="menu"]')) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Leaving the dock's territory (into chat or a meeting) closes it, so it is
  // never left hanging over a page that suppresses it.
  useEffect(() => { if (suppressedOn(pathname)) setOpen(false); }, [pathname]);

  const openFullPage = () => {
    setOpen(false);
    navigate('/app/chat');
  };

  if (!user || suppressedOn(pathname)) return null;

  const badge = unread > 99 ? '99+' : String(unread);
  /*
   * Lift above MiniCall when a call is floating in the same corner — both
   * default to bottom-right and would otherwise overlap.
   *
   * Written as whole literal class strings rather than composed from a
   * variable. Tailwind generates CSS by scanning the source for class names,
   * so `sm:${bottom}` produces a class at runtime that was never compiled and
   * silently does nothing.
   */
  const launcherPos = shouldShowMini ? 'bottom-[13.5rem] right-5' : 'bottom-5 right-5';
  const panelPos = shouldShowMini
    ? 'sm:bottom-[13.5rem] sm:right-5'
    : 'sm:bottom-5 sm:right-5';

  return createPortal(
    <>
      {/* ── The panel ──────────────────────────────────────────────────── */}
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label="Messages"
          className={
            'animate-dock-in fixed z-90 flex flex-col overflow-hidden border border-border-light '
            + 'bg-white shadow-2xl dark:border-border-dark/40 dark:bg-chrome-dark '
            /* Phone: a full sheet, because a 380px window on a 390px screen is
               a worse version of the page it is shortcutting to. */
            + 'inset-x-0 bottom-0 top-0 rounded-none '
            /* Desktop: a docked window that leaves the page visible behind it,
               which is the entire point of not navigating. */
            + 'sm:inset-auto sm:top-auto sm:h-[min(34rem,calc(100vh-8rem))] sm:w-[23.5rem] sm:rounded-2xl '
            + panelPos
          }
        >
          <header className="flex shrink-0 items-center gap-1.5 border-b border-border-light px-2 py-2 dark:border-border-dark/30">
            {active && (
              <button
                onClick={() => setActiveId(null)}
                aria-label="Back to conversations"
                className="grid h-8 w-8 place-items-center rounded-lg text-text-secondary-light transition-colors hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark"
              >
                <ChevronLeft size={17} />
              </button>
            )}
            <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              {active ? active.name : 'Messages'}
              {!active && unread > 0 && (
                <span className="ml-1.5 text-xs font-normal text-text-secondary-light dark:text-text-secondary-dark">
                  {unread} unread
                </span>
              )}
            </h2>
            {/* A dot, not a banner: losing the socket degrades chat to
                "messages arrive when you reload" — worth showing, not worth
                a bar across a 380px window. */}
            <span
              title={connected ? 'Connected' : 'Reconnecting…'}
              aria-label={connected ? 'Connected' : 'Reconnecting'}
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-500'}`}
            />
            <button
              onClick={openFullPage}
              aria-label="Open the full chat page"
              title="Open the full chat page"
              className="grid h-8 w-8 place-items-center rounded-lg text-text-secondary-light transition-colors hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark"
            >
              <Maximize2 size={15} />
            </button>
            <button
              onClick={close}
              aria-label="Close messages"
              className="grid h-8 w-8 place-items-center rounded-lg text-text-secondary-light transition-colors hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-surface-dark"
            >
              <X size={17} />
            </button>
          </header>

          <div className="min-h-0 flex-1">
            {active ? (
              /* The same thread and composer the full page renders, so every
                 feature behaves identically here. The side panels it can ask
                 for belong to the layout, so those hand off to the full page
                 rather than being reimplemented at 380px. */
              <MessageThread
                conversation={active}
                onBack={() => setActiveId(null)}
                onToggleContext={openFullPage}
                contextOpen={false}
                onOpenSearch={openFullPage}
                onOpenChannelSettings={openFullPage}
              >
                <Composer conversation={active} onOpenPanel={openFullPage} />
              </MessageThread>
            ) : (
              <ConversationList
                onOpenSaved={openFullPage}
                onOpenSettings={openFullPage}
                onOpenSearch={openFullPage}
                onOpenBrowse={openFullPage}
              />
            )}
          </div>
        </div>
      )}

      {/* ── The launcher ───────────────────────────────────────────────── */}
      <button
        ref={launcherRef}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={
          unread > 0
            ? `Messages, ${unread} unread${mentions > 0 ? `, ${mentions} mentioning you` : ''}`
            : 'Messages'
        }
        title="Messages  (Ctrl/⌘ ⇧ M)"
        className={
          `group fixed z-90 ${launcherPos} grid h-14 w-14 place-items-center rounded-full `
          + 'bg-blue-600 text-white shadow-lg shadow-blue-600/25 outline-none transition-all duration-200 '
          + 'hover:scale-105 hover:bg-blue-500 focus-visible:ring-4 focus-visible:ring-blue-500/40 '
          + 'active:scale-95 dark:bg-blue-600 dark:hover:bg-blue-500 '
          /* Hidden behind the sheet on a phone, where the panel is the screen
             and a button floating over it would just cover a message. */
          + (open ? 'hidden sm:grid' : '')
        }
      >
        <MessageSquare size={22} className="transition-transform duration-200 group-hover:-rotate-6" />

        {unread > 0 && (
          <>
            {/* One ping on arrival, not a permanent animation. */}
            {pulse && (
              <span
                aria-hidden="true"
                className="absolute inset-0 animate-ping rounded-full bg-blue-500/50"
              />
            )}
            <span
              aria-hidden="true"
              className={
                'absolute -right-0.5 -top-0.5 grid min-w-[1.25rem] place-items-center rounded-full '
                + 'px-1 text-[11px] font-bold leading-5 text-white ring-2 ring-white dark:ring-chrome-dark '
                /* A mention is a different kind of urgent from an unread
                   message, and the colour is the only thing that says so at
                   14px. */
                + (mentions > 0 ? 'bg-rose-500' : 'bg-slate-700 dark:bg-slate-600')
              }
            >
              {badge}
            </span>
          </>
        )}
      </button>
    </>,
    document.body,
  );
};

/**
 * Behind a boundary with a null fallback, like MiniCall: the dock is a
 * convenience layered over every page in the app, and it must never be able to
 * take the page underneath down with it.
 */
export const ChatDock: React.FC = () => (
  <ErrorBoundary fallback={null}>
    <DockInner />
  </ErrorBoundary>
);
