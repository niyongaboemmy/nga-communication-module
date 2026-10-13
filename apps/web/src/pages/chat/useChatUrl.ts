import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useChat } from './ChatProvider';
import * as chatApi from './api';

/**
 * The open conversation lives in the URL.
 *
 *   /app/chat?c=<conversation>              open it
 *   /app/chat?c=<conversation>&m=<message>  open it at that message
 *   /app/chat?c=<conversation>&thread=<id>  open it with that thread
 *   /app/chat?dm=<user>                     open (or start) a DM
 *   /app/chat?browse=1                      the channel directory
 *
 * Global search, notifications and "copy link" all produce these, and none of
 * them did anything before — the page opened whatever conversation happened
 * to be first. Opening a conversation also pushes a history entry, so on a
 * phone Back returns to the list instead of leaving Chat altogether.
 *
 * Two one-way effects rather than one two-way one: URL → state runs only when
 * the URL changes (a link, Back, Forward); state → URL only when the open
 * conversation changes (a click in the list). Each sees the other's write as
 * already in step, so neither can loop.
 */
export function useChatUrl(opts: {
  onBrowse: () => void;
  /** Set true right before an automatic open, so it replaces rather than pushes. */
  replaceNextRef: React.MutableRefObject<boolean>;
}): { back: () => void } {
  const navigate = useNavigate();
  /** Whether the open conversation was pushed on top of the list in this session. */
  const pushedOverList = useRef(false);
  const {
    activeId, setActiveId, conversationsLoading, openThread, jumpTo, messagesLoading, refresh,
    messagesConversationId,
  } = useChat();
  const [params, setParams] = useSearchParams();
  const urlC = params.get('c');
  const pending = useRef<{ m: string | null; thread: string | null }>({ m: null, thread: null });
  /**
   * The conversation the URL last asked for. Until state catches up with it,
   * state → URL must not run: the render that applies a link still holds the
   * old (often empty) open conversation, and syncing that back would erase
   * the link before it took effect.
   */
  const expected = useRef<string | null | undefined>(undefined);
  /** False from the moment a link is applied until state reflects it. */
  const caughtUp = useRef(false);
  const { onBrowse, replaceNextRef } = opts;

  // URL → state
  useEffect(() => {
    if (conversationsLoading) return;

    const dm = params.get('dm');
    if (dm) {
      void chatApi.openDirect(dm)
        .then(async (conversation) => {
          await refresh();
          setParams({ c: conversation.id }, { replace: true });
        })
        .catch(() => setParams({}, { replace: true }));
      return;
    }
    if (params.get('browse')) {
      onBrowse();
      // Functional: another hook (the panel sync) may write in the same tick.
      setParams((prev) => { const next = new URLSearchParams(prev); next.delete('browse'); return next; }, { replace: true });
      return;
    }

    pending.current = { m: params.get('m'), thread: params.get('thread') };
    expected.current = urlC ?? null;
    caughtUp.current = (urlC ?? null) === (activeId ?? null);
    if (!caughtUp.current) setActiveId(urlC);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- URL-driven only
  }, [urlC, params.get('dm'), params.get('browse'), params.get('m'), params.get('thread'), conversationsLoading]);

  // Once the target conversation has loaded, honour the message / thread asked for.
  useEffect(() => {
    // Wait for *this* conversation's first page: jumping earlier would be
    // overwritten by that page arriving a moment later.
    if (!activeId || activeId !== urlC || messagesLoading || messagesConversationId !== activeId) return;
    const { m, thread } = pending.current;
    if (!m && !thread) return;
    pending.current = { m: null, thread: null };
    if (thread) openThread(thread);
    if (m) void jumpTo(m);
    setParams((prev) => { const next = new URLSearchParams(prev); next.delete('m'); next.delete('thread'); return next; }, { replace: true });
  }, [activeId, urlC, messagesLoading, messagesConversationId, openThread, jumpTo, params, setParams]);

  // state → URL
  useEffect(() => {
    if (expected.current === undefined) return;            // URL not applied yet
    if (!caughtUp.current) {
      // Still applying a link: the only change to accept is the one asked for.
      if ((activeId ?? null) === expected.current) caughtUp.current = true;
      return;
    }
    if ((activeId ?? null) === (urlC ?? null)) return;
    expected.current = activeId ?? null;
    // Closing is a step back, not a new step: replace, so Back never returns
    // to a conversation the person just closed.
    const replace = replaceNextRef.current || !activeId;
    replaceNextRef.current = false;
    pushedOverList.current = Boolean(activeId) && !replace && !urlC;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (activeId) next.set('c', activeId); else next.delete('c');
      next.delete('m'); next.delete('thread');
      return next;
    }, { replace });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state-driven only
  }, [activeId]);

  /** The in-app back button: the same as the browser's when we pushed the entry. */
  const back = () => {
    if (pushedOverList.current) { pushedOverList.current = false; navigate(-1); }
    else setActiveId(null);
  };
  return { back };
}
