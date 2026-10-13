import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, Search, ShieldAlert, LogIn, ListFilter } from 'lucide-react';
import { apiGet } from '../../lib/api';
import { Card, PageHeader, Spinner, EmptyState, Badge, Avatar, Button } from '../../components/ui';
import { LoadError } from '../../components/LoadError';

/**
 * The audit log (F-13). Opens on privileged actions; sign-ins and routine
 * activity are a tab away. Each entry says in words what changed ("Student →
 * Admin", "+2 permissions") and names its target with a link, and the raw
 * details are one click away. Filters live in the address; older entries
 * load on demand.
 */

interface Target { label: string; link: string | null; gone?: boolean }
interface AuditEntry {
  id: string; action: string; target_type: string | null; target_id: string | null;
  metadata: Record<string, unknown>; ip_address: string | null; created_at: string;
  actor_name: string | null; actor_email: string | null; actor_avatar?: string | null; actor_id?: string | null;
  category: 'privileged' | 'signins' | 'routine'; target: Target | null;
}
interface Refs { people: Record<string, string>; roles: Record<string, string> }
type AuditPage = { data?: AuditEntry[]; nextBefore?: string | null; refs?: Refs };
interface ActionCount { action: string; count: number; category: string }

const VIEWS = [
  { id: 'privileged', label: 'Privileged', Icon: ShieldAlert, hint: 'Authority used over people or the system.' },
  { id: 'signins', label: 'Sign-ins', Icon: LogIn, hint: 'Every sign-in through NGA MIS.' },
  { id: 'all', label: 'Everything', Icon: ListFilter, hint: 'Including routine activity: posts, mail, blocks.' },
] as const;

const ACTION_LABEL: Record<string, string> = {
  'auth.login': 'Signed in',
  'user.role.assign': 'Changed a role',
  'user.suspended': 'Suspended an account',
  'user.active': 'Reactivated an account',
  'users.export': 'Exported the user list',
  'role.create': 'Created a role',
  'role.update': 'Edited a role',
  'role.delete': 'Deleted a role',
  'chat.oversight.conversation.read': 'Read a conversation (oversight)',
  'chat.oversight.message.remove': 'Removed a message (oversight)',
  'chat.oversight.attachment.remove': 'Removed an attachment (oversight)',
  'chat.message.delete_other': 'Deleted someone’s message',
  'chat.member.remove': 'Removed a member',
  'chat.ownership.transfer': 'Transferred ownership',
  'chat.retention.set': 'Set message retention',
  'chat.channel.archive': 'Archived a channel',
  'chat.channel.unarchive': 'Unarchived a channel',
  'chat.report.resolved': 'Resolved a report',
  'chat.report.dismissed': 'Dismissed a report',
  'feed.moderation.remove': 'Removed a post (moderation)',
  'feed.moderation.restore': 'Restored a post (moderation)',
  'feed.page.create': 'Created a page',
  'feed.page.delete': 'Deleted a page',
  'mail.campaign.submit': 'Submitted a campaign',
  'mail.campaign.approve': 'Approved a campaign',
  'mail.campaign.reject': 'Rejected a campaign',
  'meet.deleted': 'Deleted a meeting',
};
const labelOf = (action: string) => ACTION_LABEL[action] ?? action.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());

const TONE: Record<string, 'blue' | 'green' | 'amber' | 'red' | 'slate'> = {
  'auth.login': 'green', 'user.active': 'green',
  'user.role.assign': 'amber', 'role.update': 'blue', 'role.create': 'blue',
  'role.delete': 'red', 'user.suspended': 'red', 'users.export': 'amber',
};
const toneOf = (a: string) => TONE[a] ?? (/remove|delete|reject/.test(a) ? 'red' : /oversight/.test(a) ? 'amber' : 'slate');

/** What changed, in words. Falls back to the first few details. */
function describe(e: AuditEntry, refs: Refs): React.ReactNode {
  const m = e.metadata ?? {};
  const role = (id: unknown) => (typeof id === 'number' ? refs.roles[String(id)] ?? `role #${id}` : 'Unassigned');
  switch (e.action) {
    case 'user.role.assign':
      return <><b>{(m.roleNameFrom as string) ?? role(m.from)}</b> → <b>{(m.roleNameTo as string) ?? role(m.to)}</b></>;
    case 'role.update': {
      const diff = m.diff as { added?: string[]; removed?: string[] } | undefined;
      const renamed = m.renamed as { from: string; to: string } | undefined;
      const parts: React.ReactNode[] = [];
      if (renamed) parts.push(<span key="r">renamed <b>{renamed.from}</b> → <b>{renamed.to}</b></span>);
      if (m.description) parts.push(<span key="d">description changed</span>);
      if (diff?.added?.length) parts.push(<span key="a" className="text-emerald-700 dark:text-emerald-300" title={diff.added.join(', ')}>+{diff.added.length} ({diff.added.slice(0, 2).join(', ')}{diff.added.length > 2 ? '…' : ''})</span>);
      if (diff?.removed?.length) parts.push(<span key="x" className="text-red-700 dark:text-red-300" title={diff.removed.join(', ')}>−{diff.removed.length} ({diff.removed.slice(0, 2).join(', ')}{diff.removed.length > 2 ? '…' : ''})</span>);
      return parts.length ? parts.reduce<React.ReactNode[]>((acc, p, i) => (i ? [...acc, ' · ', p] : [p]), []) : 'No change';
    }
    case 'role.create': return <>{String(m.level ?? '')} · {Array.isArray(m.permissionKeys) ? m.permissionKeys.length : 0} permissions</>;
    case 'role.delete': return <>“{String(m.name ?? '')}”</>;
    case 'chat.retention.set': return m.days ? <>Messages kept {String(m.days)} days</> : <>Messages kept forever</>;
    case 'chat.member.remove': return <>Removed {refs.people[String(m.removed)] ?? 'a member'}</>;
    case 'chat.ownership.transfer': return <>To {refs.people[String(m.newOwnerId ?? m.userId)] ?? 'another member'}</>;
    case 'users.export': return <>{Number(m.rows ?? 0)} {Number(m.rows) === 1 ? 'row' : 'rows'}</>;
    case 'auth.login': return e.ip_address ? <>from {e.ip_address}</> : null;
    default: {
      const simple = Object.entries(m).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 3);
      return simple.length ? simple.map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`).join(' · ') : null;
    }
  }
}

function relative(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: s > 300 * 86400 ? 'numeric' : undefined });
}

const fieldClass = 'rounded-lg border border-slate-300 px-2 py-2 text-sm dark:border-border-dark dark:bg-elevated-dark dark:text-slate-100';

export const AuditLog: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const view = (['signins', 'all'] as const).find((v) => v === params.get('view')) ?? 'privileged';
  const q = params.get('q') ?? '';
  const action = params.get('action') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  const setFilter = useCallback((patch: Record<string, string | null>) => {
    setParams((cur) => {
      const next = new URLSearchParams(cur);
      for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
      return next;
    }, { replace: true });
  }, [setParams]);

  const [draft, setDraft] = useState(q);
  useEffect(() => { setDraft(q); }, [q]);
  useEffect(() => {
    if (draft === q) return;
    const t = setTimeout(() => setFilter({ q: draft.trim() || null }), 350);
    return () => clearTimeout(t);
  }, [draft, q, setFilter]);

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [refs, setRefs] = useState<Refs>({ people: {}, roles: {} });
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [actions, setActions] = useState<ActionCount[]>([]);
  const generation = useRef(0);

  const query = useMemo(() => {
    const s = new URLSearchParams({ view, limit: '50' });
    if (q) s.set('q', q);
    if (action) s.set('action', action);
    if (from) s.set('from', from);
    if (to) s.set('to', to);
    return s;
  }, [view, q, action, from, to]);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    setFailed(false);
    try {
      const r = await apiGet<AuditEntry[]>(`/api/audit?${query}`) as AuditPage;
      if (gen !== generation.current) return;
      setEntries(r.data ?? []);
      setRefs(r.refs ?? { people: {}, roles: {} });
      setNextBefore(r.nextBefore ?? null);
    } catch {
      if (gen === generation.current) setFailed(true);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [query]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    apiGet<ActionCount[]>('/api/audit/actions').then((r) => setActions(r.data ?? [])).catch(() => {});
  }, []);

  const loadMore = async () => {
    if (!nextBefore) return;
    const gen = generation.current;
    setLoadingMore(true);
    try {
      const s = new URLSearchParams(query);
      s.set('before', nextBefore);
      const r = await apiGet<AuditEntry[]>(`/api/audit?${s}`) as AuditPage;
      if (gen !== generation.current) return;
      setEntries((cur) => [...cur, ...(r.data ?? [])]);
      setRefs((cur) => ({ people: { ...cur.people, ...r.refs?.people }, roles: { ...cur.roles, ...r.refs?.roles } }));
      setNextBefore(r.nextBefore ?? null);
    } catch { /* the button stays for another try */ } finally {
      setLoadingMore(false);
    }
  };

  const shownActions = actions.filter((a) => view === 'all' || a.category === view);
  const filtered = Boolean(q || action || from || to);

  return (
    <div className="px-4 pb-24 pt-5 sm:px-6 sm:pt-6">
      <PageHeader
        title="Audit log"
        subtitle="Append-only: the database refuses to change or delete these entries."
      />

      <div role="tablist" aria-label="Which entries" className="mb-3 flex flex-wrap gap-1.5">
        {VIEWS.map(({ id, label, Icon, hint }) => (
          <button key={id} role="tab" aria-selected={view === id} title={hint}
            onClick={() => setFilter({ view: id === 'privileged' ? null : id, action: null })}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              view === id ? 'bg-blue-600 text-white'
                : 'border border-border-light text-text-secondary-light hover:bg-surface-light dark:border-border-dark/50 dark:text-text-secondary-dark dark:hover:bg-surface-dark'}`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-60 sm:max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Person, action or id"
            aria-label="Search the audit log" className={`${fieldClass} w-full py-2 pl-9 pr-3`} />
        </div>
        <select value={action} onChange={(e) => setFilter({ action: e.target.value || null })} aria-label="Filter by action" className={fieldClass}>
          <option value="">All actions</option>
          {shownActions.map((a) => <option key={a.action} value={a.action}>{labelOf(a.action)} ({a.count})</option>)}
        </select>
        <label className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
          From <input type="date" value={from} max={to || undefined} onChange={(e) => setFilter({ from: e.target.value || null })} aria-label="From date" className={fieldClass} />
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
          To <input type="date" value={to} min={from || undefined} onChange={(e) => setFilter({ to: e.target.value || null })} aria-label="To date" className={fieldClass} />
        </label>
        {filtered && (
          <button onClick={() => { setDraft(''); setFilter({ q: null, action: null, from: null, to: null }); }}
            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">Clear filters</button>
        )}
      </div>

      <Card className="overflow-hidden">
        {loading && entries.length === 0 ? (
          <div className="grid place-items-center py-16"><Spinner /></div>
        ) : failed && entries.length === 0 ? (
          <LoadError what="the audit log" onRetry={() => void load()} />
        ) : entries.length === 0 ? (
          <EmptyState title={filtered ? 'Nothing matches these filters' : 'No entries here yet'}
            hint={filtered ? 'Widen the dates or clear the filters.' : VIEWS.find((v) => v.id === view)?.hint} />
        ) : (
          <div className={`overflow-x-auto transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
            <table className="table-stack w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-border-dark dark:bg-chrome-dark/50 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-medium">When</th>
                  <th className="px-4 py-3 font-medium">Who</th>
                  <th className="px-4 py-3 font-medium">Action</th>
                  <th className="px-4 py-3 font-medium">Target</th>
                  <th className="px-4 py-3 font-medium">What changed</th>
                  <th className="px-2 py-3"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-border-dark">
                {entries.map((e) => {
                  const expanded = open.has(e.id);
                  const change = describe(e, refs);
                  return (
                    <React.Fragment key={e.id}>
                      <tr className="align-top hover:bg-slate-50 dark:hover:bg-card-dark/40">
                        <td data-label="When" className="whitespace-nowrap px-4 py-2.5 text-xs text-slate-500 tabular-nums dark:text-slate-400">
                          <time dateTime={e.created_at} title={new Date(e.created_at).toLocaleString()}>{relative(e.created_at)}</time>
                        </td>
                        <td data-primary className="px-4 py-2.5 text-slate-700 dark:text-slate-200">
                          {e.actor_name ? (
                            <span className="inline-flex items-center gap-2">
                              <Avatar name={e.actor_name} src={e.actor_avatar ?? undefined} size={24} tintKey={e.actor_id ?? undefined} />
                              {e.actor_name}
                            </span>
                          ) : <span className="text-slate-400" title={e.actor_id ?? undefined}>{e.actor_id ? 'Former user' : 'System'}</span>}
                        </td>
                        <td data-label="Action" className="px-4 py-2.5">
                          <Badge tone={toneOf(e.action)}>{labelOf(e.action)}</Badge>
                          {e.category === 'routine' && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-slate-400">routine</span>}
                        </td>
                        <td data-label="Target" className="px-4 py-2.5 text-xs">
                          {e.target ? (
                            <span className="inline-flex flex-wrap items-center gap-1">
                              {e.target.link && !e.target.gone
                                ? <Link to={e.target.link} className="font-medium text-blue-600 hover:underline dark:text-blue-400">{e.target.label}</Link>
                                : <span className="font-medium text-slate-700 dark:text-slate-200">{e.target.label}</span>}
                              {e.target.gone && <span className="rounded bg-slate-100 px-1 text-[10px] uppercase text-slate-500 dark:bg-card-dark dark:text-slate-400">deleted</span>}
                            </span>
                          ) : <span className="text-slate-400">—</span>}
                        </td>
                        <td data-label="What changed" className="px-4 py-2.5 text-xs text-slate-600 dark:text-slate-300">
                          {change ?? <span className="text-slate-400">—</span>}
                        </td>
                        <td data-actions className="px-2 py-2">
                          <button aria-expanded={expanded} aria-label={expanded ? 'Hide details' : 'Show details'}
                            onClick={() => setOpen((cur) => { const n = new Set(cur); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })}
                            className="grid h-7 w-7 place-items-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-card-dark dark:hover:text-slate-200">
                            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="bg-slate-50/70 dark:bg-chrome-dark/40">
                          <td colSpan={6} className="px-4 py-3">
                            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
                              <dt className="text-slate-400">Action key</dt><dd className="font-mono text-slate-600 dark:text-slate-300">{e.action}</dd>
                              <dt className="text-slate-400">When</dt><dd className="text-slate-600 dark:text-slate-300">{new Date(e.created_at).toLocaleString()}</dd>
                              {e.actor_email && <><dt className="text-slate-400">Who</dt><dd className="text-slate-600 dark:text-slate-300">{e.actor_email}</dd></>}
                              {e.target_type && <><dt className="text-slate-400">Target</dt><dd className="font-mono text-slate-600 dark:text-slate-300">{e.target_type}:{e.target_id}</dd></>}
                              {e.ip_address && <><dt className="text-slate-400">IP address</dt><dd className="font-mono text-slate-600 dark:text-slate-300">{e.ip_address}</dd></>}
                            </dl>
                            <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-white p-2 font-mono text-[11px] text-slate-600 dark:bg-card-dark dark:text-slate-300">
                              {JSON.stringify(e.metadata, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {entries.length > 0 && (
          <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 text-xs text-slate-500 dark:border-border-dark dark:text-slate-400">
            <span className="tabular-nums">{entries.length} shown</span>
            {nextBefore ? (
              <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? <Spinner className="h-3 w-3" /> : null} Load older entries
              </Button>
            ) : <span>That is everything{filtered ? ' that matches' : ''}.</span>}
          </div>
        )}
      </Card>
    </div>
  );
};
