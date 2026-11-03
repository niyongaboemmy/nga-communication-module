import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useNotify } from '../../context/NotificationContext';
import { Menu, X, Mails, PenSquare } from 'lucide-react';
import { EmptyState, IconButton, Spinner } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { onSocket } from '../../lib/socket';
import { Sidebar } from './Sidebar';
import { MailList } from './MailList';
import { ThreadView } from './ThreadView';
import { Composer, type ComposerSeed, type QueuedSend } from './Composer';
import { SESSION_KEY } from '../../lib/api';
import * as api from './api';
import { MAIL_FOLDERS } from '@tupo/shared';
import type { MailFolder, MailLabel, MailboxCounts, MailThreadSummary } from '@tupo/shared';
import './mail.css';
import { useResync } from '../../hooks/useResync';
import { isTypingTarget } from '../../lib/shortcuts';
import { usePermissions } from '../../hooks/usePermissions';

const EMPTY_COUNTS: MailboxCounts = { inbox: 0, starred: 0, drafts: 0, scheduled: 0 };

/**
 * Mail, three panes.
 *
 *   ≥1024px  folders │ thread list │ open thread
 *   <1024px  folders drawer; the list is the screen until a thread is opened,
 *            then the thread replaces it and Back returns
 */
export const MailLayout: React.FC = () => {
  const { threadId: routeThreadId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const { notify, confirm: confirmed } = useNotify();
  // Folder and label live in the address (C-11): a reload, a shared link or
  // Back lands on the same view.
  const [params] = useSearchParams();
  const FOLDERS: MailFolder[] = ['inbox', 'starred', 'snoozed', 'sent', 'drafts', 'scheduled', 'archive', 'spam', 'trash'];
  const folder: MailFolder = FOLDERS.includes(params.get('folder') as MailFolder) ? params.get('folder') as MailFolder : 'inbox';
  const labelId = params.get('label');
  const setView = useCallback((next: { folder?: MailFolder | null; label?: string | null }) => {
    const q = new URLSearchParams();
    if (next.folder && next.folder !== 'inbox') q.set('folder', next.folder);
    if (next.label) q.set('label', next.label);
    return q.toString();
  }, []);
  const [counts, setCounts] = useState<MailboxCounts>(EMPTY_COUNTS);
  const [labels, setLabels] = useState<MailLabel[]>([]);
  const [selected, setSelected] = useState<string | null>(routeThreadId ?? null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [drawer, setDrawer] = useState(false);
  // `n` remounts the composer: a new compose or forward while one is open
  // replaces it, and the one being replaced saves itself as a draft (C-10).
  const [composer, setComposerState] = useState<{ seed?: ComposerSeed; n: number } | null>(null);
  const composeCount = useRef(0);
  const setComposer = (c: { seed?: ComposerSeed } | null) =>
    setComposerState(c ? { ...c, n: ++composeCount.current } : null);
  /*
   * Undo send (U-10), as in Gmail: Send closes the composer at once and the
   * message leaves UNDO_MS later unless Undo is pressed, which reopens it as it
   * was. The message is already a saved draft, and leaving the page (or Mail)
   * while it is held sends it straight away, so nothing written is ever lost.
   */
  const UNDO_MS = 6_000;
  const held = useRef<{ job: QueuedSend; timer: number } | null>(null);
  const sendHeld = useCallback(async (job: QueuedSend) => {
    try {
      const r = await api.compose(job.payload);
      bumpAllRef.current();
      confirmed(r.scheduled ? 'Scheduled' : 'Sent');
    } catch (e) {
      notify({ title: 'Your message was not sent', body: e instanceof Error ? e.message : undefined, tone: 'error', durationMs: 0 });
      setComposer({ seed: job.reopen });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const queueSend = (job: QueuedSend) => {
    // Another held message goes now: only the newest send is undoable.
    if (held.current) { window.clearTimeout(held.current.timer); void sendHeld(held.current.job); }
    setComposer(null);
    const timer = window.setTimeout(() => { held.current = null; void sendHeld(job); }, UNDO_MS);
    held.current = { job, timer };
    notify({
      title: 'Sending…', body: 'Changed your mind? Undo.', tone: 'info', durationMs: UNDO_MS, key: 'mail-undo-send',
      action: {
        label: 'Undo',
        onClick: () => {
          if (held.current?.job !== job) return;
          window.clearTimeout(held.current.timer);
          held.current = null;
          setComposer({ seed: job.reopen });
        },
      },
    });
  };
  useEffect(() => {
    const flush = () => {
      const h = held.current;
      if (!h) return;
      window.clearTimeout(h.timer);
      held.current = null;
      // keepalive: the request outlives the page.
      void fetch('/api/mail/compose', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem(SESSION_KEY) ?? ''}` },
        body: JSON.stringify(h.job.payload),
      }).catch(() => {});
    };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, []);
  // c compose, ? the list of shortcuts (U-10).
  const [showKeys, setShowKeys] = useState(false);
  const { can } = usePermissions();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showKeysRef.current) { setShowKeys(false); return; }
      if (isTypingTarget(e)) return;
      if (e.key === 'c' && can('MAIL_SEND')) { e.preventDefault(); setComposer({}); }
      else if (e.key === '?') { e.preventDefault(); setShowKeys((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const showKeysRef = useRef(showKeys);
  showKeysRef.current = showKeys;
  const [signatureHtml, setSignatureHtml] = useState<string>('');
  const [ready, setReady] = useState(false);

  const refreshMeta = useCallback(async () => {
    const [c, l] = await Promise.all([api.getCounts().catch(() => EMPTY_COUNTS), api.listLabels().catch(() => [])]);
    setCounts(c); setLabels(l);
  }, []);

  useEffect(() => {
    Promise.all([
      refreshMeta(),
      api.getPrefs().then((p) => setSignatureHtml(p.signatureEnabled ? p.signatureHtml : '')).catch(() => {}),
    ]).finally(() => setReady(true));
  }, [refreshMeta]);

  // Read, moved or starred on another device (or in this one's thread view):
  // the folder counts and label badges move with it.
  useEffect(() => onSocket('mail:counts', () => { refreshMeta(); }), [refreshMeta]);

  // Live: a mail notification means the inbox changed.
  useEffect(() => onSocket('notification:new', (n) => {
    if (typeof n?.kind === 'string' && n.kind.startsWith('mail.')) {
      refreshMeta();
      setRefreshKey((k) => k + 1);
    }
  }), [refreshMeta]);

  // Keep the URL in step so a thread is linkable and Back works.
  useEffect(() => { setSelected(routeThreadId ?? null); }, [routeThreadId]);

  const viewQuery = setView({ folder, label: labelId });
  const openThread = (t: MailThreadSummary) => {
    setSelected(t.threadId);
    navigate(`/app/mail/t/${t.threadId}${viewQuery ? `?${viewQuery}` : ''}`);
  };
  const closeThread = () => { setSelected(null); navigate(`/app/mail${viewQuery ? `?${viewQuery}` : ''}`); };

  const bumpAll = () => { refreshMeta(); setRefreshKey((k) => k + 1); };
  const bumpAllRef = useRef(bumpAll);
  bumpAllRef.current = bumpAll;
  // Mail that arrived while the socket was down or the tab was asleep (S-15).
  useResync(bumpAll);

  const pickFolder = (f: MailFolder) => {
    const q = setView({ folder: f });
    setSelected(null);
    navigate(`/app/mail${q ? `?${q}` : ''}`);
  };
  const pickLabel = (id: string) => {
    setSelected(null);
    navigate(`/app/mail?${setView({ label: id })}`);
  };

  if (!ready) return <div className="grid h-full place-items-center"><Spinner /></div>;

  const sidebar = (
    <Sidebar
      folder={folder}
      labelId={labelId}
      counts={counts}
      labels={labels}
      onSelectFolder={pickFolder}
      onSelectLabel={pickLabel}
      onCompose={() => setComposer({})}
      onLabelsChanged={refreshMeta}
      onNavigate={() => setDrawer(false)}
    />
  );

  return (
    <div className="flex h-full overflow-hidden bg-white dark:bg-transparent">
      {/* Folders — persistent on desktop, drawer on mobile */}
      <aside className="hidden w-60 shrink-0 border-r border-border-light dark:border-border-dark/50 lg:block">
        {sidebar}
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-30 flex lg:hidden" onClick={() => setDrawer(false)}>
          <div className="w-64 bg-white shadow-xl dark:bg-elevated-dark" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-end p-2"><IconButton label="Close" size="sm" onClick={() => setDrawer(false)}><X size={18} /></IconButton></div>
            {sidebar}
          </div>
        </div>
      )}

      {/* Thread list */}
      <section className={`flex min-w-0 flex-1 flex-col border-r border-border-light dark:border-border-dark/50 lg:max-w-md ${selected ? 'hidden lg:flex' : 'flex'}`}>
        <div className="flex items-center gap-2 border-b border-border-light px-2 py-1.5 lg:hidden dark:border-border-dark/50">
          <IconButton label="Folders" size="sm" onClick={() => setDrawer(true)}><Menu size={18} /></IconButton>
          <span className="text-sm font-semibold">Mail</span>
          {/* The folders drawer holds Compose too, but writing a message is
              the main action on a phone — it must not be two taps away. */}
          <button
            type="button"
            data-track="tupo.mail.compose_open"
            onClick={() => setComposer({})}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-blue-600 px-3.5 text-sm font-medium text-white shadow-sm shadow-blue-600/20 transition-colors hover:bg-blue-500 active:scale-[0.98]"
          >
            <PenSquare size={15} /> Compose
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <MailList
            folder={folder}
            labelId={labelId}
            labels={labels}
            selectedThreadId={selected}
            refreshKey={refreshKey}
            onOpen={openThread}
            onChanged={bumpAll}
          />
        </div>
      </section>

      {/* Open thread */}
      <section className={`min-w-0 flex-1 ${selected ? 'flex' : 'hidden lg:flex'} flex-col`}>
        {selected ? (
          <ThreadView
            key={selected}
            threadId={selected}
            labels={labels}
            myUserId={user?.id ?? ''}
            onBack={closeThread}
            onChanged={bumpAll}
            onCompose={(seed) => setComposer({ seed })}
          />
        ) : (
          <EmptyState icon={<Mails />} title="Select a conversation" hint="Pick a message from the list, or start a new one." />
        )}
      </section>

      {showKeys && (
        <div role="dialog" aria-modal="true" aria-labelledby="mail-keys-title" onClick={() => setShowKeys(false)}
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-elevated-dark">
            <h2 id="mail-keys-title" className="mb-3 text-sm font-semibold">Keyboard shortcuts</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {([['c', 'Compose'], ['j / k', 'Next / previous conversation'], ['e', 'Archive'], ['#', 'Delete'], ['s', 'Star'],
                ['u', 'Mark unread'], ['r', 'Reply'], ['a', 'Reply all'], ['f', 'Forward'], ['/', 'Search'], ['?', 'This list']] as const).map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt><kbd className="rounded border border-border-light px-1.5 py-0.5 font-mono text-xs dark:border-border-dark">{k}</kbd></dt>
                  <dd className="text-text-secondary-light dark:text-text-secondary-dark">{v}</dd>
                </React.Fragment>
              ))}
            </dl>
            <button onClick={() => setShowKeys(false)} autoFocus className="mt-4 w-full rounded-full bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700">Close</button>
          </div>
        </div>
      )}

      {composer && (
        <Composer
          key={composer.n}
          seed={composer.seed}
          signatureHtml={signatureHtml}
          onClose={() => setComposer(null)}
          onDraftSaved={() => { confirmed('Draft saved'); refreshMeta(); }}
          onQueueSend={queueSend}
          onSent={(r) => {
            setComposer(null);
            bumpAll();
            if (!r.draft && !r.scheduled) { navigate(`/app/mail/t/${r.threadId}${viewQuery ? `?${viewQuery}` : ''}`); setSelected(r.threadId); }
          }}
        />
      )}
    </div>
  );
};

export default MailLayout;
