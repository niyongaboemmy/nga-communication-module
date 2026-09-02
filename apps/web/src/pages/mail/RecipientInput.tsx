import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Avatar } from '../../components/ui';
import * as api from './api';
import type { MailPerson } from '@tupo/shared';

/** A recipient chip's value: either `userId:<id>` or a bare email address. */
export type RecipientToken = string;

interface Props {
  label: string;
  values: RecipientToken[];
  onChange: (next: RecipientToken[]) => void;
  autofocus?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const RecipientInput: React.FC<Props> = ({ label, values, onChange, autofocus }) => {
  const [text, setText] = useState('');
  const [results, setResults] = useState<MailPerson[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!text.trim()) { setResults([]); return; }
    const t = setTimeout(() => {
      api.searchDirectory(text.trim()).then((people) => {
        setResults(people.filter((p) => !values.includes(`userId:${p.userId}`)));
        setOpen(true);
        setActive(0);
      }).catch(() => setResults([]));
    }, 180);
    return () => clearTimeout(t);
  }, [text, values]);

  // Remember display names for the userId tokens we have added, so a chip still
  // reads "Aline Uwase" after the search results that produced it are cleared.
  const [nameMap, setNameMap] = useState<Record<string, string>>({});

  const add = (token: RecipientToken, name?: string) => {
    if (!values.includes(token)) onChange([...values, token]);
    const resolved = name ?? results.find((r) => `userId:${r.userId}` === token)?.name;
    if (resolved && token.startsWith('userId:')) setNameMap((m) => ({ ...m, [token]: resolved }));
    setText('');
    setResults([]);
    setOpen(false);
  };

  const commitTyped = () => {
    const v = text.trim().replace(/[,;]$/, '');
    if (EMAIL_RE.test(v)) add(v);
  };

  const remove = (token: RecipientToken) => onChange(values.filter((t) => t !== token));

  const labelFor = (token: RecipientToken) =>
    token.startsWith('userId:')
      ? (nameMap[token] ?? results.find((r) => `userId:${r.userId}` === token)?.name ?? 'Recipient')
      : token;

  return (
    <div className="relative flex items-start gap-2 border-b border-border-light py-2 dark:border-border-dark/60" ref={boxRef}>
      <span className="mt-1.5 w-10 shrink-0 text-xs font-medium uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">
        {label}
      </span>
      <div className="flex flex-1 flex-wrap items-center gap-1.5">
        {values.map((token) => (
          <span
            key={token}
            className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
          >
            {token.startsWith('userId:') ? labelFor(token) : token}
            <button type="button" aria-label="Remove" onClick={() => remove(token)}>
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          autoFocus={autofocus}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => { commitTyped(); setTimeout(() => setOpen(false), 150); }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === 'Tab' || e.key === ',') && (open && results[active])) {
              e.preventDefault();
              add(`userId:${results[active]!.userId}`, results[active]!.name);
            } else if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault(); commitTyped();
            } else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Backspace' && !text && values.length) remove(values[values.length - 1]!);
          }}
          placeholder={values.length ? '' : 'Name or email address'}
          className="min-w-[8rem] flex-1 bg-transparent py-1 text-sm outline-none"
        />
      </div>

      {open && results.length > 0 && (
        <div className="absolute left-12 top-full z-20 mt-1 w-72 overflow-hidden rounded-xl border border-border-light bg-white shadow-lg dark:border-border-dark dark:bg-elevated-dark">
          {results.slice(0, 8).map((p, i) => (
            <button
              key={p.userId ?? p.address}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(`userId:${p.userId}`, p.name)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                i === active ? 'bg-surface-light dark:bg-surface-dark' : ''
              }`}
            >
              <Avatar name={p.name} src={p.avatarUrl ?? undefined} size={26} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{p.name}</span>
                <span className="block truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">{p.address}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
