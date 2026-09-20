import React, { useEffect, useState } from 'react';

/**
 * Shared primitives, styled to the NGA design language used by the Central MIS
 * and TaskMentor: blue-600 accent, the semantic `surface/card/border/text-*`
 * tokens defined in index.css, `rounded-xl` chrome, class-based dark mode.
 *
 * Keeping them here means a design change lands in one file across every Tupo
 * screen — chat, admin, and everything Phase 1+ adds.
 */

/* ------------------------------------------------------------------ *
 * Surfaces
 * ------------------------------------------------------------------ */

export const Card: React.FC<{ className?: string; children: React.ReactNode }> = ({ className = '', children }) => (
  <div
    className={`rounded-xl border border-border-light bg-card-light dark:border-border-dark/40 dark:bg-elevated-dark/40 ${className}`}
  >
    {children}
  </div>
);

/* ------------------------------------------------------------------ *
 * Buttons
 * ------------------------------------------------------------------ */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
};

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary', size = 'md', className = '', children, ...rest
}) => {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors duration-150 ' +
    'disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900';
  const sizes = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2 text-sm' };
  const variants = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700  ',
    secondary:
      'border border-border-light bg-white text-text-primary-light hover:bg-surface-light ' +
      'dark:border-border-dark dark:bg-elevated-dark dark:text-text-primary-dark dark:hover:bg-card-dark',
    ghost:
      'text-text-secondary-light hover:bg-surface-light hover:text-text-primary-light ' +
      'dark:text-text-secondary-dark dark:hover:bg-surface-dark dark:hover:text-text-primary-dark',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  };
  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
};

type IconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Required: an icon-only control is invisible to a screen reader without it. */
  label: string;
  active?: boolean;
  size?: 'sm' | 'md';
  /** Which side the hover tooltip opens on. Default 'bottom' clears toolbars
   *  pinned to the top of the screen, where an above-button tooltip would be
   *  clipped by the viewport edge. */
  tooltipSide?: 'top' | 'bottom';
};

/** The square icon control used throughout the chat chrome and the top bar. */
export const IconButton: React.FC<IconButtonProps> = ({
  label, active = false, size = 'md', tooltipSide = 'bottom', className = '', children, ...rest
}) => {
  const dims = size === 'sm' ? 'h-8 w-8' : 'h-9 w-9';
  const tooltipPos = tooltipSide === 'bottom'
    ? 'top-full mt-2'
    : 'bottom-full mb-2';
  return (
    <span className="group/tooltip relative inline-flex">
      <button
        type="button"
        aria-label={label}
        className={`grid ${dims} shrink-0 place-items-center rounded-full transition-colors duration-150 ` +
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ' +
          (active
            ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
            : 'text-text-secondary-light hover:bg-surface-light hover:text-text-primary-light ' +
              'dark:text-text-secondary-dark dark:hover:bg-surface-dark dark:hover:text-text-primary-dark') +
          ` ${className}`}
        {...rest}
      >
        {children}
      </button>
      <span
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md ` +
          'bg-gray-900 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-lg ' +
          'shadow-black/20 transition-all duration-150 ease-out ' +
          (tooltipSide === 'bottom' ? '-translate-y-0.5 group-hover/tooltip:translate-y-0' : 'translate-y-0.5 group-hover/tooltip:translate-y-0') +
          ' group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100 ' +
          `dark:bg-gray-700 ${tooltipPos}`}
      >
        {label}
      </span>
    </span>
  );
};

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

export type Presence = 'online' | 'away' | 'busy' | 'offline';

const PRESENCE_TONE: Record<Presence, string> = {
  online: 'bg-emerald-500',
  away: 'bg-amber-400',
  busy: 'bg-red-500',
  offline: 'bg-slate-300 dark:bg-slate-600',
};

export const PresenceDot: React.FC<{
  presence: Presence;
  className?: string;
  style?: React.CSSProperties;
}> = ({ presence, className = '', style }) => (
  <span
    role="img"
    aria-label={presence}
    style={style}
    className={`block rounded-full ring-2 ring-white dark:ring-border-dark ${PRESENCE_TONE[presence]} ${className}`}
  />
);

/**
 * Deterministic avatar tint. The same person keeps the same colour on every
 * device and every reload, which is what makes an avatar scannable in a list —
 * a random colour per render would defeat the point.
 */
const AVATAR_TINTS: [string, ...string[]] = [
  'from-blue-500 to-blue-600',
  'from-violet-500 to-violet-600',
  'from-emerald-500 to-emerald-600',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-rose-600',
  'from-cyan-500 to-sky-600',
  'from-indigo-500 to-indigo-600',
  'from-teal-500 to-emerald-600',
];

function tintFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_TINTS[Math.abs(hash) % AVATAR_TINTS.length] ?? AVATAR_TINTS[0];
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) return '?';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

export const Avatar: React.FC<{
  name: string;
  src?: string;
  size?: number;
  presence?: Presence;
  /** Channel avatars are square-ish; people are round (§15.2: full for avatars). */
  shape?: 'circle' | 'rounded';
  /**
   * What the tint is derived from, when that should not be the name.
   *
   * Two people called Aline Uwase otherwise get the same initials *and* the
   * same colour, which makes them indistinguishable at a glance. Pass a user id
   * and they get different colours.
   */
  tintKey?: string;
  className?: string;
}> = ({ name, src, size = 36, presence, shape = 'circle', tintKey, className = '' }) => {
  const radius = shape === 'circle' ? 'rounded-full' : 'rounded-xl';
  // A `src` that fails to load (an expired ticket, a dropped connection, a
  // deleted file) must fall back to the initials disc below — never a bare
  // broken-image icon, which is all a plain `<img>` gives you on its own.
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  return (
    <span className={`relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }}>
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className={`h-full w-full object-cover ${radius} border border-black/5 dark:border-white/10`}
        />
      ) : (
        <span
          aria-hidden="true"
          className={`grid h-full w-full place-items-center bg-gradient-to-br ${tintFor(tintKey ?? name)} ${radius} font-semibold text-white`}
          style={{ fontSize: Math.max(10, size * 0.36) }}
        >
          {initialsOf(name)}
        </span>
      )}
      {presence && (
        <PresenceDot
          presence={presence}
          className="absolute -bottom-0.5 -right-0.5"
          /* Scales with the avatar so a 24px avatar does not get a 12px dot. */
          style={{ width: Math.max(8, size * 0.28), height: Math.max(8, size * 0.28) }}
        />
      )}
    </span>
  );
};

/* ------------------------------------------------------------------ *
 * Feedback
 * ------------------------------------------------------------------ */

export const Badge: React.FC<{
  tone?: 'blue' | 'slate' | 'green' | 'amber' | 'red';
  children: React.ReactNode;
}> = ({ tone = 'slate', children }) => {
  const tones = {
    blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
    slate: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
    green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
    red: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
};

/** The unread pill in the conversation list and rail (UX-9). */
export const UnreadBadge: React.FC<{ count: number; mention?: boolean }> = ({ count, mention = false }) => {
  if (count <= 0) return null;
  return (
    <span
      aria-label={`${count} unread${mention ? ', mentions you' : ''}`}
      className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums text-white ${
        mention ? 'bg-red-500' : 'bg-blue-600'
      }`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
};

export const PageHeader: React.FC<{
  title: string; subtitle?: string; actions?: React.ReactNode;
}> = ({ title, subtitle, actions }) => (
  <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
    <div>
      <h1 className="text-xl font-semibold tracking-tight text-text-primary-light dark:text-text-primary-dark">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-text-secondary-light dark:text-text-secondary-dark">{subtitle}</p>}
    </div>
    {actions && <div className="flex items-center gap-2">{actions}</div>}
  </div>
);

/**
 * A `<span>`, not a `<div>`.
 *
 * A spinner belongs inside paragraphs, buttons and headings — all of which
 * accept phrasing content only. As a div it produced "In HTML, <div> cannot be
 * a descendant of <p>" and a hydration warning wherever it was used inline.
 * `inline-block` keeps the box identical; flex and grid parents blockify their
 * children anyway, so no existing layout changes.
 */
export const Spinner: React.FC<{ className?: string }> = ({ className = '' }) => (
  <span
    role="status"
    aria-label="Loading"
    className={`inline-block h-5 w-5 animate-spin rounded-full border-2 border-border-light border-t-blue-600 dark:border-border-dark dark:border-t-blue-500 ${className}`}
  />
);

/** UX-4 — skeletons for list and conversation loading, never spinners. */
export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`skeleton rounded-lg bg-slate-200/70 dark:bg-card-dark/50 ${className}`} />
);

export const EmptyState: React.FC<{
  title: string;
  hint?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}> = ({ title, hint, icon, action }) => (
  <div className="grid place-items-center px-6 py-16 text-center">
    <div className="max-w-sm">
      {icon && (
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-surface-light text-text-secondary-light dark:bg-surface-dark dark:text-text-secondary-dark">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">{title}</p>
      {hint && <p className="mt-1.5 text-sm leading-relaxed text-text-secondary-light dark:text-text-secondary-dark">{hint}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  </div>
);

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export const SearchInput: React.FC<
  React.InputHTMLAttributes<HTMLInputElement> & { icon?: React.ReactNode; wrapperClassName?: string }
> = ({ icon, wrapperClassName = '', className = '', ...rest }) => (
  <div className={`relative ${wrapperClassName}`}>
    {icon && (
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary-light dark:text-text-secondary-dark">
        {icon}
      </span>
    )}
    <input
      type="search"
      className={`w-full rounded-xl border border-border-light bg-surface-light py-2 text-sm text-text-primary-light placeholder:text-text-secondary-light/80 ` +
        `focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 ` +
        `dark:border-border-dark/50 dark:bg-elevated-dark/60 dark:text-text-primary-dark dark:placeholder:text-text-secondary-dark/70 dark:focus:bg-elevated-dark ` +
        `${icon ? 'pl-9 pr-3' : 'px-3'} ${className}`}
      {...rest}
    />
  </div>
);
