import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Menu, X, Mails } from 'lucide-react';
import { EmptyState, IconButton, Spinner } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { onSocket } from '../../lib/socket';
import { Sidebar } from './Sidebar';
import { MailList } from './MailList';
import { ThreadView } from './ThreadView';
import { Composer, type ComposerSeed } from './Composer';
import * as api from './api';
import type { MailFolder, MailLabel, MailboxCounts, MailThreadSummary } from '@tupo/shared';
import './mail.css';

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

  const [folder, setFolder] = useState<MailFolder>('inbox');
  const [labelId, setLabelId] = useState<string | null>(null);
  const [counts, setCounts] = useState<MailboxCounts>(EMPTY_COUNTS);
  const [labels, setLabels] = useState<MailLabel[]>([]);
  const [selected, setSelected] = useState<string | null>(routeThreadId ?? null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [composer, setComposer] = useState<{ seed?: ComposerSeed } | null>(null);
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

  // Live: a mail notification means the inbox changed.
  useEffect(() => onSocket('notification:new', (n) => {
    if (typeof n?.kind === 'string' && n.kind.startsWith('mail.')) {
      refreshMeta();
      setRefreshKey((k) => k + 1);
    }
  }), [refreshMeta]);

  // Keep the URL in step so a thread is linkable and Back works.
  useEffect(() => { setSelected(routeThreadId ?? null); }, [routeThreadId]);

  const openThread = (t: MailThreadSummary) => {
    setSelected(t.threadId);
    navigate(`/app/mail/t/${t.threadId}`);
  };
  const closeThread = () => { setSelected(null); navigate('/app/mail'); };

  const bumpAll = () => { refreshMeta(); setRefreshKey((k) => k + 1); };

  const pickFolder = (f: MailFolder) => { setFolder(f); setLabelId(null); closeThread(); };
  const pickLabel = (id: string) => { setLabelId(id); setFolder('inbox'); closeThread(); };

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

      {composer && (
        <Composer
          seed={composer.seed}
          signatureHtml={signatureHtml}
          onClose={() => setComposer(null)}
          onSent={(r) => {
            setComposer(null);
            bumpAll();
            if (!r.draft && !r.scheduled) { navigate(`/app/mail/t/${r.threadId}`); setSelected(r.threadId); }
          }}
        />
      )}
    </div>
  );
};

export default MailLayout;
