import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Clock } from 'lucide-react';

/**
 * The emoji picker.
 *
 * Hand-rolled against a curated list rather than pulling in `emoji-mart` or
 * similar. Those ship a 1–2 MB dataset and a virtualised grid for a full
 * Unicode set nobody browses; the bundle cost lands on every page load in a
 * school where the median device is a low-end Android phone. A few hundred
 * emoji, searchable by keyword, covers what people actually send.
 *
 * Frequently-used is stored locally and shown first, because after a week the
 * first row is the only row most people ever touch.
 */

const RECENT_KEY = 'tupo_emoji_recent';
const MAX_RECENT = 24;

interface Group { name: string; emoji: Array<[string, string]> }

/** [emoji, space-separated search keywords] */
const GROUPS: Group[] = [
  {
    name: 'Reactions',
    emoji: [
      ['👍', 'thumbsup yes ok good approve like'], ['👎', 'thumbsdown no bad dislike'],
      ['❤️', 'heart love red'], ['🎉', 'tada party celebrate congrats'],
      ['🙏', 'pray thanks please thankyou'], ['👏', 'clap applause wellsdone bravo'],
      ['🔥', 'fire hot lit great'], ['✅', 'check done tick complete yes'],
      ['❌', 'cross no wrong error'], ['👀', 'eyes look watching seen'],
      ['💯', 'hundred perfect score'], ['🚀', 'rocket launch ship fast'],
    ],
  },
  {
    name: 'Smileys',
    emoji: [
      ['😀', 'grin happy smile'], ['😃', 'smiley happy joy'], ['😄', 'laugh happy'],
      ['😁', 'beam grin'], ['😆', 'laughing lol'], ['😅', 'sweat relief phew'],
      ['😂', 'joy lol cry laughing'], ['🤣', 'rofl rolling laughing'],
      ['🙂', 'slight smile'], ['🙃', 'upside down silly'], ['😉', 'wink'],
      ['😊', 'blush shy happy'], ['😇', 'innocent angel halo'],
      ['🥰', 'love hearts adore'], ['😍', 'hearteyes love'], ['😘', 'kiss'],
      ['😋', 'yum tasty'], ['😜', 'wink tongue silly'], ['🤪', 'zany crazy'],
      ['🤔', 'thinking hmm consider'], ['🤨', 'raised eyebrow suspicious'],
      ['😐', 'neutral meh'], ['😑', 'expressionless'], ['😴', 'sleep zzz tired'],
      ['😔', 'sad pensive'], ['😢', 'cry sad tear'], ['😭', 'sob crying'],
      ['😤', 'triumph huff'], ['😡', 'angry rage mad'], ['🤯', 'mindblown shocked'],
      ['😳', 'flushed embarrassed'], ['🥺', 'pleading please'],
      ['😬', 'grimace awkward'], ['🤐', 'zipper quiet secret'],
      ['😷', 'mask sick'], ['🤒', 'sick ill fever'], ['🥳', 'party celebrate'],
    ],
  },
  {
    name: 'People',
    emoji: [
      ['👋', 'wave hello hi bye'], ['🤝', 'handshake deal agree'],
      ['✋', 'hand stop high five'], ['🤚', 'raised hand'], ['👌', 'ok perfect'],
      ['✌️', 'peace victory'], ['🤞', 'crossed fingers hope luck'],
      ['💪', 'muscle strong'], ['🙌', 'raised hands praise celebrate'],
      ['🤦', 'facepalm'], ['🤷', 'shrug dunno'], ['🧑‍🏫', 'teacher'],
      ['👩‍🎓', 'graduate student'], ['👨‍👩‍👧', 'family parents'],
    ],
  },
  {
    name: 'School',
    emoji: [
      ['📚', 'books study library'], ['📖', 'book reading'], ['✏️', 'pencil write'],
      ['📝', 'memo note homework'], ['📐', 'ruler geometry maths'],
      ['🧮', 'abacus maths calculate'], ['🔬', 'microscope science biology'],
      ['🧪', 'test tube chemistry lab'], ['🧬', 'dna biology'],
      ['🌍', 'globe geography earth'], ['🖥️', 'computer ict'],
      ['📊', 'chart results data'], ['📈', 'graph up improve'],
      ['🏫', 'school building'], ['🎓', 'graduation cap'],
      ['🗓️', 'calendar date schedule'], ['⏰', 'alarm clock time deadline'],
      ['📌', 'pin important'], ['📎', 'paperclip attach'],
      ['🏆', 'trophy win award'], ['🥇', 'gold first medal'],
      ['⚽', 'football sport'], ['🏀', 'basketball sport'],
      ['🎵', 'music note'], ['🎨', 'art paint'],
    ],
  },
  {
    name: 'Objects & symbols',
    emoji: [
      ['💡', 'idea lightbulb'], ['⚠️', 'warning caution'], ['🚨', 'alert siren urgent'],
      ['🔒', 'lock private secure'], ['🔑', 'key access'], ['📞', 'phone call'],
      ['✉️', 'mail envelope'], ['💬', 'speech chat message'],
      ['⭐', 'star favourite'], ['✨', 'sparkles nice new'],
      ['☀️', 'sun sunny weather'], ['🌧️', 'rain weather'],
      ['☕', 'coffee break'], ['🍽️', 'food lunch meal'],
      ['➕', 'plus add'], ['➖', 'minus remove'], ['❓', 'question'],
      ['❗', 'exclamation important'], ['🔁', 'repeat again'],
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.emoji);

function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string): void {
  try {
    const next = [emoji, ...loadRecent().filter((e) => e !== emoji)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* a full or blocked localStorage must not break the picker */ }
}

/**
 * One emoji button.
 *
 * Defined at module scope, not inside `EmojiPicker`. A component declared in
 * another component's body is a **new type on every render**, so React cannot
 * reconcile it — it unmounts and remounts the whole subtree each time. With
 * three hundred cells that measured at 1,432 DOM nodes destroyed and rebuilt
 * every five seconds while the picker sat open, and it made the buttons
 * unclickable often enough for a browser test to time out on one.
 */
const EmojiCell: React.FC<{ emoji: string; onPick: (emoji: string) => void }> =
  React.memo(({ emoji, onPick }) => (
    <button
      onClick={() => onPick(emoji)}
      aria-label={emoji}
      className="grid h-8 w-8 place-items-center rounded-lg text-xl leading-none transition-colors duration-100 hover:bg-surface-light focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-surface-dark"
    >
      {emoji}
    </button>
  ));
EmojiCell.displayName = 'EmojiCell';

export const EmojiPicker: React.FC<{
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** Anchors the panel above the trigger instead of below it. */
  align?: 'up' | 'down';
}> = ({ onPick, onClose, align = 'up' }) => {
  const [query, setQuery] = useState('');
  const [recent] = useState(loadRecent);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Click-away and Escape. Both, because a picker you can only dismiss by
  // choosing something forces a choice nobody wanted to make.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    // Deferred a tick: the click that opened the picker is still propagating,
    // and would otherwise close it immediately.
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return ALL.filter(([e, kw]) => kw.includes(q) || e === q).slice(0, 60);
  }, [query]);

  const pick = useCallback((emoji: string) => {
    rememberEmoji(emoji);
    onPick(emoji);
  }, [onPick]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Choose an emoji"
      className={`absolute right-0 z-50 w-72 overflow-hidden rounded-2xl border border-border-light bg-white shadow-2xl dark:border-border-dark/50 dark:bg-elevated-dark ${
        align === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'
      }`}
    >
      <div className="border-b border-border-light p-2 dark:border-border-dark/40">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary-light dark:text-text-secondary-dark" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emoji"
            aria-label="Search emoji"
            className="w-full rounded-lg border border-border-light bg-surface-light py-1.5 pl-8 pr-2 text-xs text-text-primary-light outline-none focus:border-blue-500 dark:border-border-dark/50 dark:bg-card-dark/60 dark:text-text-primary-dark"
          />
        </div>
      </div>

      <div className="max-h-64 overflow-y-auto p-2">
        {results ? (
          results.length === 0 ? (
            <p className="py-6 text-center text-xs text-text-secondary-light dark:text-text-secondary-dark">
              Nothing matches “{query}”.
            </p>
          ) : (
            <div className="grid grid-cols-8 gap-0.5">
              {results.map(([e]) => <EmojiCell key={e} emoji={e} onPick={pick} />)}
            </div>
          )
        ) : (
          <>
            {recent.length > 0 && (
              <section className="mb-2">
                <h3 className="mb-1 flex items-center gap-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
                  <Clock size={10} /> Frequently used
                </h3>
                <div className="grid grid-cols-8 gap-0.5">
                  {recent.map((e) => <EmojiCell key={`r-${e}`} emoji={e} onPick={pick} />)}
                </div>
              </section>
            )}
            {GROUPS.map((g) => (
              <section key={g.name} className="mb-2">
                <h3 className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary-light/80 dark:text-text-secondary-dark/70">
                  {g.name}
                </h3>
                <div className="grid grid-cols-8 gap-0.5">
                  {g.emoji.map(([e]) => <EmojiCell key={e} emoji={e} onPick={pick} />)}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
};
