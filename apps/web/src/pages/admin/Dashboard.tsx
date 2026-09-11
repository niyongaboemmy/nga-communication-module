import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Users as UsersIcon, MessagesSquare, Mail, Megaphone, Video, RefreshCw,
  Circle, TrendingUp, AlertTriangle,
} from 'lucide-react';
import { apiGet, ApiError } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { Card, PageHeader, Spinner, EmptyState, Avatar } from '../../components/ui';

/* ────────────────────────────────────────────────────────────────────────── *
 * Payload types (mirror apps/api/src/services/dashboardService.ts)
 * ────────────────────────────────────────────────────────────────────────── */

interface ScopeOpt { id: string; name: string }
interface DashScope {
  level: string;
  unrestricted: boolean;
  programs: ScopeOpt[];
  grades: ScopeOpt[];
  classGroups: ScopeOpt[];
}

interface Overview {
  generatedAt: string;
  window: string;
  windowHours: number;
  scopedUsers: number | null;
  people: {
    total: number; onlineNow: number; activeToday: number; active7d: number;
    suspended: number; neverActive: number; byStatus: Record<string, number>;
  };
  chat: { messages: number; activeSenders: number; activeConversations: number; dms: number };
  mail: { sent: number; senders: number; unreadBacklog: number; bulk: number };
  feed: { posts: number; reactions: number; comments: number; activeAuthors: number };
  meet: { started: number; participants: number; liveNow: number };
  activitySeries: Array<{ bucket: string; chat: number; mail: number; feed: number }>;
  topPeople: Array<{
    id: string; name: string; avatarUrl: string | null; role: string | null;
    academicLevel: string | null; messages: number; mails: number; posts: number;
    total: number; presence: string; lastSeenAt: string | null;
  }>;
  recent: Array<{ kind: string; at: string; actorId: string | null; actorName: string | null; summary: string }>;
  quiet: Array<{ id: string; name: string; avatarUrl: string | null; role: string | null; lastSeenAt: string | null }>;
}

interface OnlinePerson {
  id: string; name: string; avatarUrl: string | null; role: string | null;
  academicLevel: string | null; status: string; lastSeenAt: string | null;
}

/* ────────────────────────────────────────────────────────────────────────── */

const POLL_MS = 15_000;

const WINDOWS: Array<{ key: string; label: string }> = [
  { key: '1h', label: '1 hour' },
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
];

const LEVEL_LABEL: Record<string, string> = {
  super_admin: 'Super admin — whole institution',
  program_lead: 'Programme lead',
  class_teacher: 'Class teacher',
  staff: 'Staff', student: 'Student', parent: 'Parent', none: 'Unscoped',
};

// dataviz categorical slots 1–3 (validated all-pairs, light + dark)
const SERIES = {
  chat: { light: '#2a78d6', dark: '#3987e5', label: 'Chat' },
  mail: { light: '#eb6834', dark: '#d95926', label: 'Mail' },
  feed: { light: '#1baf7a', dark: '#199e70', label: 'Feed' },
};

const STATUS_TONE: Record<string, string> = {
  online: 'bg-emerald-500', away: 'bg-amber-500', busy: 'bg-rose-500',
  'in-a-meeting': 'bg-violet-500', dnd: 'bg-rose-500', offline: 'bg-slate-300',
};

function agoShort(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(() =>
    document.documentElement.dataset.theme === 'dark'
    || (document.documentElement.dataset.theme !== 'light'
        && window.matchMedia?.('(prefers-color-scheme: dark)').matches));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(
      document.documentElement.dataset.theme === 'dark'
      || (document.documentElement.dataset.theme !== 'light'
          && window.matchMedia?.('(prefers-color-scheme: dark)').matches)));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Page
 * ────────────────────────────────────────────────────────────────────────── */

export const Dashboard: React.FC = () => {
  const [scope, setScope] = useState<DashScope | null>(null);
  const [win, setWin] = useState('24h');
  const [programId, setProgramId] = useState('');
  const [gradeId, setGradeId] = useState('');
  const [classGroupId, setClassGroupId] = useState('');

  const [data, setData] = useState<Overview | null>(null);
  const [online, setOnline] = useState<OnlinePerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // forces the "updated Ns ago" to re-render

  const qs = useMemo(() => {
    const p = new URLSearchParams({ window: win });
    if (programId) p.set('program', programId);
    if (gradeId) p.set('grade', gradeId);
    if (classGroupId) p.set('classGroup', classGroupId);
    return p.toString();
  }, [win, programId, gradeId, classGroupId]);

  useEffect(() => {
    apiGet<{ scope: DashScope }>('/api/dashboard/scope')
      .then((r) => setScope(r.data?.scope ?? null))
      .catch(() => { /* filters just stay empty */ });
  }, []);

  const load = useCallback(async (soft: boolean) => {
    if (soft) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const [o, on] = await Promise.all([
        apiGet<Overview>(`/api/dashboard/overview?${qs}`),
        apiGet<{ people: OnlinePerson[] }>(`/api/dashboard/online?${qs}`),
      ]);
      setData(o.data ?? null);
      setOnline(on.data?.people ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the dashboard.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [qs]);

  useEffect(() => { void load(false); }, [load]);

  // Poll, and re-render the "updated" label every second.
  useEffect(() => {
    const poll = setInterval(() => void load(true), POLL_MS);
    const label = setInterval(() => setTick((t) => t + 1), 1000);
    return () => { clearInterval(poll); clearInterval(label); };
  }, [load]);

  // Between polls: a presence change is the cheapest live signal there is.
  const nudge = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const onPresence = () => {
      if (nudge.current) return;
      nudge.current = setTimeout(() => { nudge.current = null; void load(true); }, 3000);
    };
    s.on('presence:update', onPresence);
    return () => { s.off('presence:update', onPresence); if (nudge.current) clearTimeout(nudge.current); };
  }, [load]);

  const secsAgo = data ? Math.max(0, Math.floor((Date.now() - new Date(data.generatedAt).getTime()) / 1000)) : 0;
  void tick;

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4 sm:p-6">
      <PageHeader
        title="Realtime dashboard"
        subtitle="Who is online, what is being communicated, and where attention is needed — live, scoped to what you oversee."
        actions={
          <div className="flex items-center gap-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${refreshing ? 'bg-amber-400' : 'bg-emerald-500'} ${!refreshing && 'animate-pulse'}`} />
              updated {secsAgo < 3 ? 'just now' : `${secsAgo}s ago`}
            </span>
            <button
              onClick={() => void load(true)}
              className="grid h-7 w-7 place-items-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700/60"
              aria-label="Refresh now"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        }
      />

      <ScopeBar
        scope={scope}
        win={win} setWin={setWin}
        programId={programId} setProgramId={(v) => { setProgramId(v); setGradeId(''); setClassGroupId(''); }}
        gradeId={gradeId} setGradeId={(v) => { setGradeId(v); setClassGroupId(''); }}
        classGroupId={classGroupId} setClassGroupId={setClassGroupId}
        scopedUsers={data?.scopedUsers ?? null}
      />

      {loading && !data ? (
        <div className="grid flex-1 place-items-center py-20"><Spinner /></div>
      ) : error && !data ? (
        <EmptyState title="Dashboard unavailable" hint={error} />
      ) : data ? (
        <div className="mt-4 space-y-4">
          <KpiRow data={data} />

          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <ActivityPanel data={data} />
            <OnlinePanel people={online} total={online.length} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <TopPeoplePanel people={data.topPeople} window={data.window} />
            <RecentPanel recent={data.recent} />
            <AttentionPanel data={data} />
          </div>
        </div>
      ) : null}
    </div>
  );
};

/* ────────────────────────────────────────────────────────────────────────── */

const Select: React.FC<{
  value: string; onChange: (v: string) => void; disabled?: boolean;
  placeholder: string; options: ScopeOpt[];
}> = ({ value, onChange, disabled, placeholder, options }) => (
  <select
    value={value}
    disabled={disabled || options.length === 0}
    onChange={(e) => onChange(e.target.value)}
    className="rounded-lg border border-border-light bg-white px-2.5 py-1.5 text-xs text-text-primary-light disabled:opacity-40 dark:border-border-dark/50 dark:bg-elevated-dark dark:text-text-primary-dark"
  >
    <option value="">{placeholder}</option>
    {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
  </select>
);

const ScopeBar: React.FC<{
  scope: DashScope | null;
  win: string; setWin: (v: string) => void;
  programId: string; setProgramId: (v: string) => void;
  gradeId: string; setGradeId: (v: string) => void;
  classGroupId: string; setClassGroupId: (v: string) => void;
  scopedUsers: number | null;
}> = ({ scope, win, setWin, programId, setProgramId, gradeId, setGradeId, classGroupId, setClassGroupId, scopedUsers }) => {
  // Grades narrow to the chosen programme's name prefix is not reliable; show all
  // the viewer's grades, and class groups all the viewer's class groups.
  const grades = scope?.grades ?? [];
  const classGroups = scope?.classGroups ?? [];

  return (
    <Card className="mt-3 flex flex-wrap items-center gap-2 p-2.5">
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
        <Activity size={12} /> {LEVEL_LABEL[scope?.level ?? 'none'] ?? scope?.level}
      </span>

      {scope && (scope.programs.length > 0 || scope.unrestricted) && (
        <Select value={programId} onChange={setProgramId} placeholder="All programmes" options={scope.programs} />
      )}
      {scope && (grades.length > 0 || scope.unrestricted) && (
        <Select value={gradeId} onChange={setGradeId} placeholder="All grades" options={grades} />
      )}
      {scope && (classGroups.length > 0 || scope.unrestricted) && (
        <Select value={classGroupId} onChange={setClassGroupId} placeholder="All class groups" options={classGroups} />
      )}

      <div className="ml-auto flex items-center gap-1.5">
        {scopedUsers != null && (
          <span className="text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
            {scopedUsers.toLocaleString()} in scope
          </span>
        )}
        <div className="flex rounded-lg border border-border-light p-0.5 dark:border-border-dark/50">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => setWin(w.key)}
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                win === w.key
                  ? 'bg-blue-600 text-white'
                  : 'text-text-secondary-light hover:text-text-primary-light dark:text-text-secondary-dark'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
};

/* ── KPI tiles ──────────────────────────────────────────────────────────── */

const KpiRow: React.FC<{ data: Overview }> = ({ data }) => {
  const tiles = [
    { icon: Circle, label: 'Online now', value: data.people.onlineNow, tone: 'emerald', sub: `${data.people.activeToday} active today` },
    { icon: UsersIcon, label: 'People in scope', value: data.people.total, tone: 'blue', sub: `${data.people.active7d} active this week` },
    { icon: MessagesSquare, label: `Messages · ${data.window}`, value: data.chat.messages, tone: 'blue', sub: `${data.chat.activeSenders} senders · ${data.chat.activeConversations} conversations` },
    { icon: Mail, label: `Mail sent · ${data.window}`, value: data.mail.sent, tone: 'orange', sub: `${data.mail.unreadBacklog} unread in inboxes` },
    { icon: Megaphone, label: `Feed posts · ${data.window}`, value: data.feed.posts, tone: 'teal', sub: `${data.feed.reactions} reactions · ${data.feed.comments} comments` },
    { icon: Video, label: `Meetings · ${data.window}`, value: data.meet.started, tone: 'violet', sub: data.meet.liveNow > 0 ? `${data.meet.liveNow} live now` : `${data.meet.participants} participants` },
  ];
  const toneClass: Record<string, string> = {
    emerald: 'text-emerald-600 dark:text-emerald-400',
    blue: 'text-blue-600 dark:text-blue-400',
    orange: 'text-orange-600 dark:text-orange-400',
    teal: 'text-teal-600 dark:text-teal-400',
    violet: 'text-violet-600 dark:text-violet-400',
  };
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {tiles.map((t) => (
        <Card key={t.label} className="p-3">
          <div className="flex items-center gap-1.5">
            <t.icon size={13} className={toneClass[t.tone]} />
            <span className="truncate text-[11px] font-medium uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">
              {t.label}
            </span>
          </div>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-text-primary-light dark:text-text-primary-dark">
            {t.value.toLocaleString()}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-text-secondary-light dark:text-text-secondary-dark">{t.sub}</p>
        </Card>
      ))}
    </div>
  );
};

/* ── Activity over time — stacked bars, hover tooltip ───────────────────── */

const ActivityPanel: React.FC<{ data: Overview }> = ({ data }) => {
  const dark = useIsDark();
  const s = data.activitySeries;
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...s.map((b) => b.chat + b.mail + b.feed));
  const c = (k: 'chat' | 'mail' | 'feed') => (dark ? SERIES[k].dark : SERIES[k].light);
  const totals = s.reduce((a, b) => ({ chat: a.chat + b.chat, mail: a.mail + b.mail, feed: a.feed + b.feed }), { chat: 0, mail: 0, feed: 0 });
  const perBucket = data.windowHours <= 24 ? 'hour' : 'day';

  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-center justify-between">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
          <TrendingUp size={14} /> Communication activity
        </h3>
        <div className="flex gap-3 text-[11px]">
          {(['chat', 'mail', 'feed'] as const).map((k) => (
            <span key={k} className="inline-flex items-center gap-1 text-text-secondary-light dark:text-text-secondary-dark">
              <span className="h-2 w-2 rounded-sm" style={{ background: c(k) }} />
              {SERIES[k].label} <span className="tabular-nums font-medium text-text-primary-light dark:text-text-primary-dark">{totals[k].toLocaleString()}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="relative mt-4 flex h-40 items-end gap-[3px]" onMouseLeave={() => setHover(null)}>
        {s.map((b, i) => {
          const h = ((b.chat + b.mail + b.feed) / max) * 100;
          return (
            <div
              key={b.bucket}
              className="group/bar relative flex-1"
              style={{ height: '100%' }}
              onMouseEnter={() => setHover(i)}
            >
              <div className="absolute inset-x-0 bottom-0 flex flex-col-reverse overflow-hidden rounded-[3px]" style={{ height: `${Math.max(h, b.chat + b.mail + b.feed > 0 ? 3 : 0)}%` }}>
                <span style={{ flexGrow: b.chat, background: c('chat') }} />
                <span style={{ flexGrow: b.mail, background: c('mail'), marginTop: b.mail && b.chat ? 1 : 0 }} />
                <span style={{ flexGrow: b.feed, background: c('feed'), marginTop: b.feed && (b.mail || b.chat) ? 1 : 0 }} />
              </div>
              <div className={`absolute inset-0 rounded-[3px] ${hover === i ? 'bg-black/5 dark:bg-white/10' : ''}`} />
            </div>
          );
        })}

        {hover != null && s[hover] && (
          <div className="pointer-events-none absolute -top-2 left-1/2 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border-light bg-white px-2.5 py-1.5 text-[11px] shadow-lg dark:border-border-dark/50 dark:bg-elevated-dark">
            <p className="font-medium text-text-primary-light dark:text-text-primary-dark">
              {new Date(s[hover]!.bucket).toLocaleString([], perBucket === 'hour'
                ? { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }
                : { month: 'short', day: 'numeric' })}
            </p>
            {(['chat', 'mail', 'feed'] as const).map((k) => (
              <p key={k} className="flex items-center gap-1.5 text-text-secondary-light dark:text-text-secondary-dark">
                <span className="h-2 w-2 rounded-sm" style={{ background: c(k) }} />
                {SERIES[k].label}: <span className="tabular-nums">{s[hover]![k]}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      <p className="mt-2 text-[10px] text-text-secondary-light dark:text-text-secondary-dark">
        per {perBucket}, last {data.window}
      </p>
    </Card>
  );
};

/* ── Online now — live roster ───────────────────────────────────────────── */

const OnlinePanel: React.FC<{ people: OnlinePerson[]; total: number }> = ({ people, total }) => (
  <Card className="flex min-h-0 flex-col p-4">
    <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      Online now
      <span className="ml-1 rounded-full bg-slate-100 px-1.5 text-[11px] tabular-nums text-slate-500 dark:bg-slate-700/60 dark:text-slate-300">{total}</span>
    </h3>
    <div className="mt-3 max-h-64 space-y-1 overflow-y-auto pr-1">
      {people.length === 0 ? (
        <p className="py-6 text-center text-xs text-text-secondary-light dark:text-text-secondary-dark">Nobody online in this scope.</p>
      ) : people.map((p) => (
        <div key={p.id} className="flex items-center gap-2.5 rounded-lg px-1 py-1 hover:bg-slate-50 dark:hover:bg-card-dark/40">
          <span className="relative">
            <Avatar name={p.name} src={p.avatarUrl ?? undefined} size={26} tintKey={p.id} />
            <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-elevated-dark ${STATUS_TONE[p.status] ?? 'bg-slate-300'}`} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-text-primary-light dark:text-text-primary-dark">{p.name}</span>
            <span className="block truncate text-[10px] capitalize text-text-secondary-light dark:text-text-secondary-dark">
              {p.status.replace('-', ' ')}{p.academicLevel ? ` · ${p.academicLevel.replace('_', ' ')}` : ''}
            </span>
          </span>
        </div>
      ))}
    </div>
  </Card>
);

/* ── Most active ────────────────────────────────────────────────────────── */

const TopPeoplePanel: React.FC<{ people: Overview['topPeople']; window: string }> = ({ people, window: w }) => {
  const max = Math.max(1, ...people.map((p) => p.total));
  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">Most active · {w}</h3>
      <div className="mt-3 space-y-2.5">
        {people.length === 0 ? (
          <p className="py-4 text-center text-xs text-text-secondary-light dark:text-text-secondary-dark">No activity yet.</p>
        ) : people.map((p) => (
          <div key={p.id} className="flex items-center gap-2.5">
            <span className="relative shrink-0">
              <Avatar name={p.name} src={p.avatarUrl ?? undefined} size={24} tintKey={p.id} />
              <span className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-white dark:ring-elevated-dark ${STATUS_TONE[p.presence] ?? 'bg-slate-300'}`} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-xs font-medium text-text-primary-light dark:text-text-primary-dark">{p.name}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-text-secondary-light dark:text-text-secondary-dark">{p.total}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700/60">
                <div className="h-full rounded-full bg-blue-500" style={{ width: `${(p.total / max) * 100}%` }} />
              </div>
              <p className="mt-0.5 text-[10px] text-text-secondary-light dark:text-text-secondary-dark">
                {p.messages} msg · {p.mails} mail · {p.posts} post
              </p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
};

/* ── Recent activity stream ─────────────────────────────────────────────── */

const KIND_TONE: Record<string, string> = {
  message: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  mail: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  post: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  login: 'bg-slate-100 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300',
};

const RecentPanel: React.FC<{ recent: Overview['recent'] }> = ({ recent }) => (
  <Card className="p-4">
    <h3 className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">Recent activity</h3>
    <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
      {recent.length === 0 ? (
        <p className="py-4 text-center text-xs text-text-secondary-light dark:text-text-secondary-dark">Quiet right now.</p>
      ) : recent.map((r, i) => (
        <div key={i} className="flex items-start gap-2 text-xs">
          <span className={`mt-0.5 rounded px-1 py-0.5 text-[9px] font-medium uppercase ${KIND_TONE[r.kind] ?? KIND_TONE.login}`}>
            {r.kind}
          </span>
          <span className="min-w-0 flex-1 text-text-primary-light dark:text-text-primary-dark">{r.summary}</span>
          <span className="shrink-0 tabular-nums text-[10px] text-text-secondary-light dark:text-text-secondary-dark">{agoShort(r.at)}</span>
        </div>
      ))}
    </div>
  </Card>
);

/* ── Needs attention ────────────────────────────────────────────────────── */

const AttentionPanel: React.FC<{ data: Overview }> = ({ data }) => (
  <Card className="p-4">
    <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
      <AlertTriangle size={14} className="text-amber-500" /> Needs attention
    </h3>
    <dl className="mt-3 space-y-1.5 text-xs">
      <Row label="Suspended accounts" value={data.people.suspended} />
      <Row label="Never signed in" value={data.people.neverActive} />
      <Row label="Unread mail piling up" value={data.mail.unreadBacklog} warn={data.mail.unreadBacklog > 50} />
      <Row label="Bulk / campaign mail" value={data.mail.bulk} />
    </dl>

    {data.quiet.length > 0 && (
      <>
        <p className="mt-4 text-[11px] font-medium uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">
          Not seen in 7+ days
        </p>
        <div className="mt-2 space-y-1">
          {data.quiet.map((q) => (
            <div key={q.id} className="flex items-center gap-2 text-xs">
              <Avatar name={q.name} src={q.avatarUrl ?? undefined} size={20} tintKey={q.id} />
              <span className="min-w-0 flex-1 truncate text-text-primary-light dark:text-text-primary-dark">{q.name}</span>
              <span className="shrink-0 tabular-nums text-[10px] text-text-secondary-light dark:text-text-secondary-dark">
                {q.lastSeenAt ? agoShort(q.lastSeenAt) : 'never'}
              </span>
            </div>
          ))}
        </div>
      </>
    )}
  </Card>
);

const Row: React.FC<{ label: string; value: number; warn?: boolean }> = ({ label, value, warn }) => (
  <div className="flex items-center justify-between">
    <dt className="text-text-secondary-light dark:text-text-secondary-dark">{label}</dt>
    <dd className={`tabular-nums font-medium ${warn ? 'text-amber-600 dark:text-amber-400' : 'text-text-primary-light dark:text-text-primary-dark'}`}>
      {value.toLocaleString()}
    </dd>
  </div>
);
