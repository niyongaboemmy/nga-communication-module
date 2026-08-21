import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, CalendarRange, Download, FileText, Loader2, Search, Sparkles, Users, Video,
} from 'lucide-react';
import { Avatar, Card, EmptyState } from '../../components/ui';
import * as meetApi from './api';

/**
 * Meeting history.
 *
 * "Recent" on the home page answers "what did I just do?". This answers a
 * different question — "what happened in March, and where are the notes?" —
 * and it needs the things that question implies: a window you choose, a
 * search, and a page at a time rather than an arbitrary truncation.
 *
 * The presets are what people actually ask for, and they exist because typing
 * two dates to see last month is a tax on the most common request. The custom
 * range is there for everything else.
 */

type PresetKey = '7d' | '30d' | '90d' | 'term' | 'all' | 'custom';

const PRESETS: Array<{ key: PresetKey; label: string; days: number | null }> = [
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 3 months', days: 90 },
  { key: 'term', label: 'Last 6 months', days: 182 },
  { key: 'all', label: 'All time', days: null },
];

const PAGE = 25;

/** `<input type="date">` speaks local wall-clock dates, not instants. */
const toInputDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const MeetHistory: React.FC = () => {
  const navigate = useNavigate();

  const [preset, setPreset] = useState<PresetKey>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  const [rows, setRows] = useState<meetApi.MeetingListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Typing should not put a request on the wire per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const range = useMemo(() => {
    if (preset === 'custom') {
      return {
        from: customFrom ? new Date(`${customFrom}T00:00:00`).toISOString() : undefined,
        // Inclusive of the end day, which is what picking a date means.
        to: customTo ? new Date(`${customTo}T23:59:59`).toISOString() : undefined,
      };
    }
    const days = PRESETS.find((p) => p.key === preset)?.days ?? null;
    if (days === null) return {};
    const from = new Date();
    from.setDate(from.getDate() - days);
    from.setHours(0, 0, 0, 0);
    return { from: from.toISOString() };
  }, [preset, customFrom, customTo]);

  const load = useCallback(async (offset: number) => {
    offset === 0 ? setLoading(true) : setLoadingMore(true);
    setError(null);
    try {
      const page = await meetApi.queryMeetings({
        scope: 'past', ...range, q: debounced || undefined, limit: PAGE, offset,
      });
      setRows((prev) => (offset === 0 ? page : [...prev, ...page]));
      setExhausted(page.length < PAGE);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your history.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [range, debounced]);

  useEffect(() => { void load(0); }, [load]);

  /* Grouped by month, because that is how people search their own past —
     "sometime in May" rather than "the 14th". */
  const groups = useMemo(() => {
    const map = new Map<string, meetApi.MeetingListItem[]>();
    for (const m of rows) {
      const when = m.ended_at ?? m.started_at ?? m.scheduled_start;
      const label = when
        ? new Date(when).toLocaleDateString([], { month: 'long', year: 'numeric' })
        : 'Undated';
      const list = map.get(label);
      if (list) list.push(m); else map.set(label, [m]);
    }
    return [...map.entries()];
  }, [rows]);

  const withNotes = rows.filter((m) => m.has_minutes).length;

  const exportCsv = () => {
    // Built here rather than fetched: the rows are already in the browser, and
    // this is the exact set the person is looking at, filters and all.
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csv = [
      ['Title', 'Host', 'When', 'Participants', 'Has notes', 'Code'].join(','),
      ...rows.map((m) => [
        esc(m.title), esc(m.host_name),
        esc(new Date(m.ended_at ?? m.started_at ?? m.scheduled_start ?? '').toLocaleString()),
        String(m.peak_participants ?? 0), m.has_minutes ? 'yes' : 'no', esc(m.join_code),
      ].join(',')),
    ].join('\n');
    const href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = href;
    a.download = `meeting-history-${toInputDate(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div className="tupo-aurora mx-auto max-w-7xl space-y-5 p-4 sm:p-6 lg:px-8">
      <header className="flex flex-wrap items-start justify-between gap-3 pt-2">
        <div className="min-w-0">
          <button
            onClick={() => navigate('/app/meet')}
            className="mb-1 flex items-center gap-1 text-xs font-medium text-text-secondary-light transition-colors duration-150 hover:text-text-primary-light dark:text-text-secondary-dark dark:hover:text-text-primary-dark"
          >
            <ArrowLeft size={13} /> Meet
          </button>
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary-light dark:text-text-primary-dark">
            Meeting history
          </h1>
          <p className="mt-1 text-sm text-text-secondary-light dark:text-text-secondary-dark">
            {loading
              ? 'Looking…'
              : `${rows.length}${exhausted ? '' : '+'} meeting${rows.length === 1 ? '' : 's'}` +
                (withNotes ? ` · ${withNotes} with notes` : '')}
          </p>
        </div>

        {rows.length > 0 && (
          <button
            onClick={exportCsv}
            className="flex items-center gap-1.5 rounded-full border border-border-light px-3 py-2 text-xs font-medium text-text-secondary-light transition-colors duration-150 hover:border-blue-300 hover:text-text-primary-light dark:border-border-dark/60 dark:text-text-secondary-dark dark:hover:border-blue-800 dark:hover:text-text-primary-dark"
          >
            <Download size={14} /> Export CSV
          </button>
        )}
      </header>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <Chip key={p.key} active={preset === p.key} onClick={() => setPreset(p.key)}>
              {p.label}
            </Chip>
          ))}
          <Chip active={preset === 'custom'} onClick={() => setPreset('custom')}>
            <CalendarRange size={13} /> Custom
          </Chip>
        </div>

        {preset === 'custom' && (
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-text-secondary-light dark:text-text-secondary-dark">
                From
              </span>
              <input
                type="date"
                value={customFrom}
                max={customTo || toInputDate(new Date())}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="w-full rounded-xl border border-border-light bg-white px-3 py-2 text-sm text-text-primary-light focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark dark:bg-elevated-dark dark:text-text-primary-dark"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-text-secondary-light dark:text-text-secondary-dark">
                To
              </span>
              <input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                max={toInputDate(new Date())}
                onChange={(e) => setCustomTo(e.target.value)}
                className="w-full rounded-xl border border-border-light bg-white px-3 py-2 text-sm text-text-primary-light focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark dark:bg-elevated-dark dark:text-text-primary-dark"
              />
            </label>
          </div>
        )}

        <label className="relative block">
          <span className="sr-only">Search meetings</span>
          <Search
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary-light/60 dark:text-text-secondary-dark/60"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or meeting code…"
            className="w-full rounded-xl border border-border-light bg-white py-2 pl-9 pr-3 text-sm text-text-primary-light placeholder:text-text-secondary-light/50 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark dark:bg-elevated-dark dark:text-text-primary-dark"
          />
        </label>
      </Card>

      {error && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {error}
        </p>
      )}

      {loading ? (
        <div className="grid place-items-center py-14">
          <Loader2 size={20} className="animate-spin text-text-secondary-light" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing in that range"
          hint={debounced
            ? 'No meeting matches that search in the dates you chose.'
            : 'Widen the dates, or pick “All time”.'}
        />
      ) : (
        <div className="space-y-6">
          {groups.map(([label, items]) => (
            <section key={label}>
              <h2 className="mb-2.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">
                {label}
                <span className="rounded-full bg-surface-light px-1.5 text-[10px] dark:bg-white/5">
                  {items.length}
                </span>
              </h2>
              <div className="space-y-1.5">
                {items.map((m) => (
                  <HistoryRow
                    key={m.id}
                    meeting={m}
                    onOpen={() => navigate(`/app/meet/${m.id}/summary`)}
                  />
                ))}
              </div>
            </section>
          ))}

          {!exhausted && (
            <button
              onClick={() => void load(rows.length)}
              disabled={loadingMore}
              className="flex w-full items-center justify-center gap-2 rounded-full border border-border-light px-4 py-2.5 text-sm font-medium text-text-secondary-light transition-colors duration-150 hover:border-blue-300 hover:text-text-primary-light disabled:opacity-50 dark:border-border-dark/60 dark:text-text-secondary-dark dark:hover:border-blue-800 dark:hover:text-text-primary-dark"
            >
              {loadingMore && <Loader2 size={14} className="animate-spin" />}
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const Chip: React.FC<{
  active: boolean; onClick: () => void; children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={
      'flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors duration-150 ' +
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ' +
      (active
        ? 'bg-blue-600 text-white'
        : 'bg-surface-light text-text-secondary-light hover:bg-border-light dark:bg-white/5 dark:text-text-secondary-dark dark:hover:bg-white/10')
    }
  >
    {children}
  </button>
);

const HistoryRow: React.FC<{
  meeting: meetApi.MeetingListItem; onOpen: () => void;
}> = ({ meeting, onOpen }) => {
  const when = meeting.ended_at ?? meeting.started_at ?? meeting.scheduled_start;
  const minutes = meeting.started_at && meeting.ended_at
    ? Math.max(1, Math.round(
        (Date.parse(meeting.ended_at) - Date.parse(meeting.started_at)) / 60_000))
    : null;

  return (
    <button
      onClick={onOpen}
      className="tupo-lift group flex w-full items-center gap-3 rounded-xl border border-border-light bg-white px-3 py-3 text-left hover:border-blue-300 dark:border-border-dark/40 dark:bg-elevated-dark/40 dark:hover:border-blue-800"
    >
      <Avatar name={meeting.host_name} src={meeting.host_avatar ?? undefined} size={34} />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
            {meeting.title}
          </span>
          {meeting.status === 'cancelled' && (
            <span className="shrink-0 rounded-full bg-slate-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-text-secondary-light dark:text-text-secondary-dark">
              Cancelled
            </span>
          )}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-secondary-light dark:text-text-secondary-dark">
          <span className="truncate">{meeting.host_name}</span>
          {when && (
            <>
              <span aria-hidden="true">·</span>
              <span>{new Date(when).toLocaleString([], {
                day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
              })}</span>
            </>
          )}
          {minutes !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span>{minutes < 60 ? `${minutes} min`
                : minutes % 60 === 0 ? `${minutes / 60}h`
                : `${Math.floor(minutes / 60)}h ${minutes % 60}m`}</span>
            </>
          )}
          {meeting.peak_participants > 0 && (
            <span className="flex items-center gap-0.5">
              <Users size={11} /> {meeting.peak_participants}
            </span>
          )}
        </span>
      </span>

      {/* What came out of it — the reason to open a past meeting at all. */}
      <span className="flex shrink-0 items-center gap-1.5">
        {meeting.has_minutes && (
          <span className="flex items-center gap-1 rounded-full bg-blue-500/12 px-2 py-0.5 text-[10px] font-semibold text-blue-600 dark:bg-blue-500/15 dark:text-blue-300">
            <Sparkles size={10} /> Notes
          </span>
        )}
        <span className="hidden items-center gap-1 text-[11px] font-medium text-text-secondary-light/70 transition-colors duration-150 group-hover:text-blue-500 sm:flex dark:text-text-secondary-dark/70">
          <FileText size={12} /> Summary
        </span>
      </span>
    </button>
  );
};

export default MeetHistory;
