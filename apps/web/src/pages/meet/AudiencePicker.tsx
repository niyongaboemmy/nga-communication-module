import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Globe, Loader2, Lock, Search, Users, X } from 'lucide-react';
import { MEET_CATEGORIES, CATEGORY_META } from '@tupo/shared';
import type { MeetCategory } from '@tupo/shared';
import { Avatar } from '../../components/ui';
import * as meetApi from './api';
import type { DirectoryPerson } from './api';

/**
 * Who a meeting is for.
 *
 * Presented as a *category* rather than a rule, because that is the shape of
 * the decision people actually make — "this is for my class", not "this
 * requires the MEET_JOIN permission". Each category maps onto an
 * `admissionPolicy` the server enforces (see `CATEGORY_TO_POLICY`).
 *
 * Choosing **Private** reveals a people search rather than a second screen: the
 * question "who?" is part of the same decision as "how private?", and splitting
 * them across steps is how invite lists end up empty.
 */

const CATEGORY_ICON: Record<MeetCategory, typeof Lock> = {
  private: Lock,
  loggedIn: Users,
  public: Globe,
};

export interface AudiencePickerProps {
  category: MeetCategory;
  invitees: DirectoryPerson[];
  onCategoryChange: (category: MeetCategory) => void;
  onInviteesChange: (people: DirectoryPerson[]) => void;
  /** Rendered inside the meeting room, where space is tight and it is dark. */
  compact?: boolean;
}

export const AudiencePicker: React.FC<AudiencePickerProps> = ({
  category, invitees, onCategoryChange, onInviteesChange, compact = false,
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryPerson[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  /* Debounced search. Two characters is the server's floor — below that it
   * returns nothing rather than listing the institution. */
  useEffect(() => {
    const term = query.trim();
    if (category !== 'private' || term.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      void meetApi.searchDirectory(term)
        .then((people) => {
          // Ignore a response that a newer keystroke has already superseded,
          // or the list flickers back to an older query's results.
          if (id !== requestId.current) return;
          setResults(people);
          setError(null);
        })
        .catch((err) => {
          if (id !== requestId.current) return;
          setError(err instanceof Error ? err.message : 'Could not search for people.');
        })
        .finally(() => { if (id === requestId.current) setSearching(false); });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, category]);

  const toggle = useCallback((person: DirectoryPerson) => {
    onInviteesChange(
      invitees.some((p) => p.id === person.id)
        ? invitees.filter((p) => p.id !== person.id)
        : [...invitees, person],
    );
  }, [invitees, onInviteesChange]);

  const tone = compact
    ? {
        card: 'border-white/10 hover:border-white/25',
        active: 'border-blue-500 bg-blue-500/15',
        label: 'text-white',
        hint: 'text-white/45',
        input: 'border-white/10 bg-white/5 text-white placeholder:text-white/30',
        chip: 'bg-white/10 text-white',
        row: 'hover:bg-white/5',
        rowText: 'text-white/90',
        rowHint: 'text-white/40',
      }
    : {
        card: 'border-border-light hover:border-blue-300 dark:border-border-dark/50',
        active: 'border-blue-500 bg-blue-50 dark:bg-blue-900/20',
        label: 'text-text-primary-light dark:text-text-primary-dark',
        hint: 'text-text-secondary-light dark:text-text-secondary-dark',
        input:
          'border-border-light bg-white text-text-primary-light dark:border-border-dark ' +
          'dark:bg-elevated-dark dark:text-text-primary-dark',
        chip: 'bg-surface-light text-text-primary-light dark:bg-slate-700/50 dark:text-text-primary-dark',
        row: 'hover:bg-surface-light dark:hover:bg-slate-700/30',
        rowText: 'text-text-primary-light dark:text-text-primary-dark',
        rowHint: 'text-text-secondary-light dark:text-text-secondary-dark',
      };

  return (
    <div className="space-y-3">
      <div className="grid gap-1.5 sm:grid-cols-3">
        {MEET_CATEGORIES.map((value) => {
          const Icon = CATEGORY_ICON[value];
          const meta = CATEGORY_META[value];
          const active = category === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => onCategoryChange(value)}
              aria-pressed={active}
              className={
                'flex flex-col gap-1 rounded-xl border p-2.5 text-left transition-colors duration-150 ' +
                (active ? tone.active : tone.card)
              }
            >
              <span className="flex items-center gap-1.5">
                <Icon size={14} className={active ? 'text-blue-500' : tone.hint} />
                <span className={`text-sm font-medium ${tone.label}`}>{meta.label}</span>
                {active && <Check size={13} className="ml-auto text-blue-500" />}
              </span>
              <span className={`text-[11px] leading-relaxed ${tone.hint}`}>{meta.hint}</span>
            </button>
          );
        })}
      </div>

      {CATEGORY_META[category].warning && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {CATEGORY_META[category].warning}
        </p>
      )}

      {/* The people search belongs to Private, and appears with it. */}
      {category === 'private' && (
        <div className="animate-fade-in space-y-2">
          <label className="block">
            <span className={`mb-1 flex items-center gap-1.5 text-xs font-medium ${tone.hint}`}>
              <Search size={12} /> Who is this for?
            </span>
            <div className="relative">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or email…"
                className={`w-full rounded-xl border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none ${tone.input}`}
              />
              {searching && (
                <Loader2
                  size={14}
                  className={`absolute right-3 top-1/2 -translate-y-1/2 animate-spin ${tone.hint}`}
                />
              )}
            </div>
          </label>

          {error && <p className="text-xs text-red-500">{error}</p>}

          {invitees.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {invitees.map((person) => (
                <span
                  key={person.id}
                  className={`animate-pop flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 text-xs ${tone.chip}`}
                >
                  <Avatar name={person.name} src={person.avatar_url ?? undefined} size={20} />
                  <span className="max-w-[9rem] truncate">{person.name}</span>
                  <button
                    type="button"
                    onClick={() => toggle(person)}
                    aria-label={`Remove ${person.name}`}
                    className="opacity-50 transition-opacity duration-150 hover:opacity-100"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {results.length > 0 && (
            <ul className={`max-h-52 overflow-y-auto rounded-xl border ${tone.card}`}>
              {results.map((person) => {
                const chosen = invitees.some((p) => p.id === person.id);
                return (
                  <li key={person.id}>
                    <button
                      type="button"
                      onClick={() => toggle(person)}
                      className={`flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors duration-150 ${tone.row}`}
                    >
                      <Avatar name={person.name} src={person.avatar_url ?? undefined} size={26} />
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm ${tone.rowText}`}>{person.name}</span>
                        <span className={`block truncate text-[11px] ${tone.rowHint}`}>
                          {person.email}{person.role_name ? ` · ${person.role_name}` : ''}
                        </span>
                      </span>
                      {chosen
                        ? <Check size={15} className="shrink-0 text-blue-500" />
                        : <span className={`shrink-0 text-[11px] ${tone.rowHint}`}>Add</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {query.trim().length >= 2 && !searching && results.length === 0 && !error && (
            <p className={`text-xs ${tone.hint}`}>Nobody matches “{query.trim()}”.</p>
          )}

          {invitees.length === 0 && (
            <p className={`text-[11px] leading-relaxed ${tone.hint}`}>
              With nobody chosen, only you will be able to join. You can invite people later too.
            </p>
          )}
        </div>
      )}
    </div>
  );
};
