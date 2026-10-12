import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  HeartHandshake, MessageSquare, Mail, Phone, Copy, Check, CalendarClock, CalendarDays,
  Briefcase, Clock, GraduationCap, RefreshCw, Users, Hash,
} from 'lucide-react';
import { Avatar, Button, EmptyState, PageHeader, SearchInput, Skeleton, Spinner } from '../../components/ui';
import { useNotify } from '../../context/NotificationContext';
import { useChat } from '../chat/ChatProvider';
import * as chatApi from '../chat/api';
import type { Mentorship, MentorshipPerson } from '../chat/api';
import { toPresence } from '../chat/types';
import { lastSeenLabel } from '../chat/data';

/**
 * Mentorship, as NGA MIS assigns it.
 *
 * A student lands here from the MIS "My Mentor" page: their mentor's full
 * profile, presence and every way to reach them, with Message one click away.
 * A mentor sees their mentees and can open a chat with any of them.
 *
 * `?message=1` opens the chat with the mentor straight away — what the MIS
 * "Message on Tupo" button links to.
 */

const PRESENCE_LABEL: Record<string, string> = {
  online: 'Online now',
  away: 'Away',
  busy: 'Busy',
  'in-a-meeting': 'In a meeting',
  dnd: 'Do not disturb',
};

const ROLE_LABEL: Record<string, string> = {
  TEACHER: 'Teacher', STAFF: 'Staff', ADMIN: 'Administration', STUDENT: 'Student', PARENT: 'Parent',
};
const roleLabel = (t: string | null) =>
  t ? ROLE_LABEL[t] ?? t.charAt(0) + t.slice(1).toLowerCase() : null;

const formatDay = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

function presenceLine(p: MentorshipPerson): string {
  const presence = p.profile?.presence ?? 'offline';
  if (presence !== 'offline') return PRESENCE_LABEL[presence] ?? 'Online';
  return lastSeenLabel(p.profile?.lastSeenAt) ?? 'Offline';
}

/** Their wall-clock time, when they have set a zone and it differs from yours. */
function theirTime(timezone: string | null | undefined): string | null {
  if (!timezone) return null;
  try {
    const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
    const mine = new Date().toLocaleTimeString(undefined, opts);
    const theirs = new Date().toLocaleTimeString(undefined, { ...opts, timeZone: timezone });
    return theirs === mine ? null : theirs;
  } catch {
    return null;
  }
}

const Detail: React.FC<{ icon: React.ReactNode; label: string; value: React.ReactNode; copy?: string | null }> = ({
  icon, label, value, copy,
}) => {
  const { notify } = useNotify();
  const [copied, setCopied] = useState(false);
  const doCopy = async () => {
    if (!copy) return;
    try {
      await navigator.clipboard.writeText(copy);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      notify({ title: 'Could not copy', body: 'Select the text and copy it instead.', tone: 'error' });
    }
  };
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border-light bg-surface-light/60 p-3 transition-colors hover:border-blue-200 dark:border-border-dark/40 dark:bg-card-dark/30 dark:hover:border-blue-800/60">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">{label}</dt>
        <dd className="mt-0.5 break-words text-sm font-medium text-text-primary-light dark:text-text-primary-dark">{value}</dd>
      </div>
      {copy && (
        <button
          type="button"
          onClick={doCopy}
          aria-label={`Copy ${label.toLowerCase()}`}
          title={`Copy ${label.toLowerCase()}`}
          className="shrink-0 rounded-lg p-1.5 text-text-secondary-light hover:bg-white hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-text-secondary-dark dark:hover:bg-elevated-dark dark:hover:text-blue-400"
        >
          {copied ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}
        </button>
      )}
    </div>
  );
};

const Cover: React.FC<{ url: string | null; className?: string }> = ({ url, className = 'h-28 md:h-40' }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <div className={`relative overflow-hidden bg-blue-600 ${className}`} data-testid="mentor-cover">
      {url && !failed && (
        <img src={url} alt="" onError={() => setFailed(true)} className="absolute inset-0 h-full w-full object-cover" />
      )}
    </div>
  );
};

const MentorCard: React.FC<{ mentor: MentorshipPerson; opening: boolean; onMessage: () => void }> = ({
  mentor, opening, onMessage,
}) => {
  const p = mentor.profile;
  const role = p?.title || roleLabel(mentor.userType);
  const local = theirTime(p?.timezone);
  const online = (p?.presence ?? 'offline') !== 'offline';
  return (
    <section
      aria-label="Your mentor"
      className="animate-fade-in overflow-hidden rounded-2xl border border-border-light bg-white shadow-sm dark:border-border-dark/40 dark:bg-elevated-dark/60"
    >
      <Cover url={mentor.coverUrl} />
      <div className="px-4 pb-5 md:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <Avatar
            name={mentor.name}
            src={mentor.avatarUrl ?? undefined}
            size={96}
            presence={toPresence(p?.presence)}
            tintKey={mentor.tupoUserId ?? undefined}
            preview
            previewCaption={role ?? undefined}
            className="-mt-12 rounded-full shadow-md ring-4 ring-white dark:ring-elevated-dark"
          />
          <div className="min-w-0 flex-1 sm:pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
              Your mentor{mentor.academicYearName ? ` · ${mentor.academicYearName}` : ''}
            </p>
            <h2 className="truncate text-xl font-semibold text-text-primary-light dark:text-text-primary-dark">
              {mentor.name}
              {p?.pronouns && (
                <span className="ml-2 text-sm font-normal text-text-secondary-light dark:text-text-secondary-dark">({p.pronouns})</span>
              )}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              {role && (
                <span className="rounded-full bg-blue-100 px-2 py-0.5 font-semibold text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                  {role}
                </span>
              )}
              <span className={`inline-flex items-center gap-1.5 ${online ? 'text-green-700 dark:text-green-400' : 'text-text-secondary-light dark:text-text-secondary-dark'}`}>
                <span className={`h-2 w-2 rounded-full ${online ? 'bg-green-500' : 'bg-slate-400'}`} aria-hidden />
                {presenceLine(mentor)}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:pt-4">
            <Button onClick={onMessage} disabled={opening || !mentor.tupoUserId} aria-label={`Message ${mentor.name}`}>
              {opening ? <Spinner className="h-4 w-4 border-white/40 border-t-white" /> : <MessageSquare size={16} />}
              Message {firstName(mentor.name)}
            </Button>
            {mentor.email && (
              <a
                href={`mailto:${mentor.email}`}
                aria-label={`Email ${mentor.name}`}
                title="Send an email"
                className="grid h-9 w-9 place-items-center rounded-full border border-border-light text-text-secondary-light transition hover:border-blue-300 hover:text-blue-600 dark:border-border-dark dark:text-text-secondary-dark dark:hover:text-blue-400"
              >
                <Mail size={16} />
              </a>
            )}
            {mentor.phone && (
              <a
                href={`tel:${mentor.phone}`}
                aria-label={`Call ${mentor.name}`}
                title="Call"
                className="grid h-9 w-9 place-items-center rounded-full border border-border-light text-text-secondary-light transition hover:border-blue-300 hover:text-blue-600 dark:border-border-dark dark:text-text-secondary-dark dark:hover:text-blue-400"
              >
                <Phone size={16} />
              </a>
            )}
          </div>
        </div>

        {p?.statusText && (
          <p className="mt-4 rounded-xl bg-surface-light px-3 py-2 text-sm text-text-primary-light dark:bg-card-dark/60 dark:text-text-primary-dark">
            {p.statusEmoji && <span className="mr-1.5">{p.statusEmoji}</span>}
            {p.statusText}
          </p>
        )}

        <dl className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {mentor.email && (
            <Detail icon={<Mail size={16} />} label="Email" copy={mentor.email}
              value={<a href={`mailto:${mentor.email}`} className="hover:text-blue-600 dark:hover:text-blue-400">{mentor.email}</a>} />
          )}
          <Detail icon={<Phone size={16} />} label="Phone" copy={mentor.phone}
            value={mentor.phone
              ? <a href={`tel:${mentor.phone}`} className="hover:text-blue-600 dark:hover:text-blue-400">{mentor.phone}</a>
              : <span className="text-text-secondary-light dark:text-text-secondary-dark">Not shared</span>} />
          {role && <Detail icon={<Briefcase size={16} />} label="Role" value={role} />}
          {formatDay(mentor.assignedAt) && (
            <Detail icon={<CalendarClock size={16} />} label="Your mentor since" value={formatDay(mentor.assignedAt)} />
          )}
          {mentor.academicYearName && <Detail icon={<CalendarDays size={16} />} label="Academic year" value={mentor.academicYearName} />}
          {local && <Detail icon={<Clock size={16} />} label="Their local time" value={local} />}
        </dl>

        <p className="mt-5 flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2.5 text-xs leading-relaxed text-blue-800 dark:border-blue-900/40 dark:bg-blue-900/20 dark:text-blue-200">
          <HeartHandshake size={16} className="mt-0.5 shrink-0" />
          Your mentor is here for you — schoolwork, worries, or anything you want to talk through.
          Send a message any time; they will see it as soon as they open Tupo.
        </p>
      </div>
    </section>
  );
};

const MenteeCard: React.FC<{ mentee: MentorshipPerson; opening: boolean; onMessage: () => void }> = ({
  mentee, opening, onMessage,
}) => {
  const online = (mentee.profile?.presence ?? 'offline') !== 'offline';
  return (
    <li className="flex items-center gap-3 rounded-2xl border border-border-light bg-white p-3 transition hover:-translate-y-0.5 hover:shadow-md dark:border-border-dark/40 dark:bg-elevated-dark/60">
      <Avatar
        name={mentee.name}
        src={mentee.avatarUrl ?? undefined}
        size={44}
        presence={toPresence(mentee.profile?.presence)}
        tintKey={mentee.tupoUserId ?? undefined}
        preview
        previewCaption={mentee.classGroupName ?? undefined}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">{mentee.name}</p>
        <p className="flex flex-wrap items-center gap-x-2 truncate text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
          {mentee.classGroupName && <span className="inline-flex items-center gap-1"><GraduationCap size={11} />{mentee.classGroupName}</span>}
          {mentee.registrationNumber && <span className="inline-flex items-center gap-1"><Hash size={11} />{mentee.registrationNumber}</span>}
        </p>
        <p className={`text-[11px] ${online ? 'text-green-700 dark:text-green-400' : 'text-text-secondary-light dark:text-text-secondary-dark'}`}>
          {presenceLine(mentee)}
        </p>
      </div>
      <Button size="sm" variant="secondary" onClick={onMessage} disabled={opening || !mentee.tupoUserId}
        aria-label={`Message ${mentee.name}`}>
        {opening ? <Spinner className="h-3 w-3" /> : <MessageSquare size={14} />}
        <span className="hidden sm:inline">Message</span>
      </Button>
    </li>
  );
};

export const MentorshipPage: React.FC = () => {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { notify } = useNotify();
  const { refresh, setActiveId } = useChat();
  const [data, setData] = useState<Mentorship | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const autoOpened = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await chatApi.getMentorship());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your mentorship.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const message = useCallback(async (person: MentorshipPerson) => {
    if (!person.tupoUserId || openingId) return;
    setOpeningId(person.tupoUserId);
    try {
      const conversation = await chatApi.openDirect(person.tupoUserId);
      await refresh();
      setActiveId(conversation.id);
      navigate('/app/chat');
    } catch (err) {
      notify({
        title: 'Could not open that conversation',
        body: err instanceof Error ? err.message : undefined,
        tone: 'error',
      });
    } finally {
      setOpeningId(null);
    }
  }, [navigate, notify, openingId, refresh, setActiveId]);

  // Arriving from MIS "Message on Tupo": go straight to the chat, once.
  useEffect(() => {
    if (autoOpened.current || !data?.mentor || params.get('message') !== '1') return;
    autoOpened.current = true;
    const next = new URLSearchParams(params);
    next.delete('message');
    setParams(next, { replace: true });
    void message(data.mentor);
  }, [data, params, setParams, message]);

  const mentees = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = data?.mentees ?? [];
    if (!q) return list;
    return list.filter((m) =>
      [m.name, m.classGroupName, m.registrationNumber].some((v) => v?.toLowerCase().includes(q)));
  }, [data, query]);

  return (
    <div className="mx-auto w-full max-w-5xl p-4 md:p-8">
      <PageHeader
        title="Mentorship"
        subtitle="Your mentor and mentees, as assigned by the school in NGA MIS."
        actions={
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </Button>
        }
      />

      {loading && !data ? (
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-40 w-full rounded-2xl" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" />
          </div>
        </div>
      ) : error ? (
        <EmptyState
          icon={<HeartHandshake size={24} />}
          title="Mentorship could not be loaded"
          hint={error}
          action={<Button onClick={() => void load()}><RefreshCw size={14} /> Try again</Button>}
        />
      ) : !data?.mentor && !data?.mentees.length ? (
        <EmptyState
          icon={<HeartHandshake size={24} />}
          title="No mentor assigned yet"
          hint="When the school assigns you a mentor in NGA MIS, their profile appears here and you can message them directly."
        />
      ) : (
        <div className="space-y-8">
          {data.mentor && (
            <MentorCard
              mentor={data.mentor}
              opening={openingId === data.mentor.tupoUserId}
              onMessage={() => void message(data.mentor!)}
            />
          )}

          {data.mentees.length > 0 && (
            <section aria-label="Your mentees">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
                  <Users size={16} className="text-blue-600 dark:text-blue-400" />
                  Your mentees
                  <span className="rounded-full bg-surface-light px-2 py-0.5 text-[11px] font-medium text-text-secondary-light dark:bg-card-dark dark:text-text-secondary-dark">
                    {data.mentees.length}
                  </span>
                </h2>
                {data.mentees.length > 6 && (
                  <div className="w-full sm:w-64">
                    <SearchInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search mentees" aria-label="Search mentees" />
                  </div>
                )}
              </div>
              {mentees.length ? (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {mentees.map((m) => (
                    <MenteeCard
                      key={m.misUserId}
                      mentee={m}
                      opening={openingId === m.tupoUserId}
                      onMessage={() => void message(m)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark">No mentee matches “{query}”.</p>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
};
