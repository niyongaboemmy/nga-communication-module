import React from 'react';
import { Avatar } from '../../components/ui';
import { useMediaUrl } from './uploads';
import { toPresence } from './types';
import type { Conversation } from './types';

/**
 * What a conversation looks like, in one place.
 *
 * Three call sites render this — the sidebar row, the thread header and the
 * details panel — and before this component they each had their own copy of
 * the "DM? then the person's picture, otherwise an emoji tile" branch. Adding
 * an uploaded logo to three copies is how two of them end up still showing the
 * emoji.
 *
 * Precedence: an uploaded logo, then the emoji, then the type's icon.
 */
export const ConversationAvatar: React.FC<{
  conversation: Conversation;
  size: number;
  /** Shown when there is neither a logo nor an emoji — usually the # / 📣 icon. */
  fallback?: React.ReactNode;
  /** Tailwind radius for the non-DM tile; people are always round. */
  radius?: string;
  className?: string;
  /** For a DM: click opens the person's photo full size (see Avatar `preview`). */
  preview?: boolean;
}> = ({ conversation: c, size, fallback, radius = 'rounded-xl', className = '', preview = false }) => {
  // A DM shows the peer's own avatar, which is a plain URL — no ticket needed,
  // so don't mint one.
  const { url } = useMediaUrl(c.type === 'dm' ? null : c.avatarFileId);

  if (c.type === 'dm') {
    return (
      <Avatar
        name={c.name}
        src={c.avatarUrl ?? undefined}
        size={size}
        presence={toPresence(c.peer?.presence)}
        className={className}
        preview={preview}
      />
    );
  }

  if (url) {
    return (
      <img
        src={url}
        alt=""
        style={{ width: size, height: size }}
        className={`shrink-0 border border-black/5 object-cover dark:border-white/10 ${radius} ${className}`}
      />
    );
  }

  return (
    <span
      style={{ width: size, height: size }}
      className={`grid shrink-0 place-items-center ${radius} ${
        c.type === 'announcement'
          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
          : 'bg-slate-100 text-slate-500 dark:bg-card-dark/60 dark:text-slate-300'
      } ${className}`}
    >
      {c.iconEmoji
        ? <span className="leading-none" style={{ fontSize: Math.max(12, size * 0.42) }}>{c.iconEmoji}</span>
        : fallback}
    </span>
  );
};
