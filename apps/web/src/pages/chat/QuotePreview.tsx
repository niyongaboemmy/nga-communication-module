import React from 'react';
import { Camera, FileText, Film, Mic, Paperclip } from 'lucide-react';
import type { WireMessage } from '@tupo/shared';
import { useMediaUrl } from './uploads';

/**
 * The message a reply answers, drawn inside the reply's bubble (FR-MSG-7).
 *
 * R-01: the quote used to be one `nowrap` line, which set the bubble's
 * natural width to the whole quoted sentence and pushed the bubble — and on a
 * phone the reply's own words — off the screen. It now wraps and is clamped
 * to two lines, inside a tinted block (the NGA UI rules allow no accent strip).
 *
 * R-08: a quoted photo, voice note or file says what it is — "Photo",
 * "Voice message · 0:12", the file's name — with a small thumbnail for a
 * picture, instead of the word "attachment".
 *
 * Tappable: it jumps to the original, fetching the surrounding page first if
 * the original is not loaded.
 */

type Quote = NonNullable<WireMessage['replyTo']>;

const KIND_ICON = { image: Camera, video: Film, audio: Mic, document: FileText, other: Paperclip } as const;

function clock(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** What a quoted attachment is, in words. */
export function describeAttachment(a: NonNullable<Quote['attachment']>): string {
  switch (a.kind) {
    case 'image': return 'Photo';
    case 'video': return a.durationMs ? `Video · ${clock(a.durationMs)}` : 'Video';
    case 'audio': return a.durationMs ? `Voice message · ${clock(a.durationMs)}` : 'Voice message';
    default: return a.name || 'File';
  }
}

const Thumb: React.FC<{ fileId: string }> = ({ fileId }) => {
  const { url } = useMediaUrl(fileId, true, { thumb: true });
  return url
    ? <img src={url} alt="" className="h-9 w-9 shrink-0 rounded-md object-cover" />
    : <span className="h-9 w-9 shrink-0 rounded-md bg-black/10 dark:bg-white/10" aria-hidden="true" />;
};

export const QuotePreview: React.FC<{
  replyTo: Quote;
  onDark: boolean;
  onJump: () => void;
}> = ({ replyTo, onDark, onJump }) => {
  const a = replyTo.deleted ? null : replyTo.attachment ?? null;
  const Icon = a ? KIND_ICON[a.kind] ?? Paperclip : null;
  const text = replyTo.deleted ? 'Message deleted' : (replyTo.body ?? (a ? describeAttachment(a) : 'Attachment'));
  return (
    <button
      type="button"
      onClick={onJump}
      aria-label={`Replying to ${replyTo.senderName}: ${text}. Go to the message`}
      className={`mb-1.5 flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors duration-150 ${
        onDark
          ? 'bg-white/15 text-white hover:bg-white/20'
          : 'bg-blue-50 text-text-primary-light hover:bg-blue-100/70 dark:bg-blue-900/30 dark:text-text-primary-dark dark:hover:bg-blue-900/45'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className={`block truncate font-semibold ${onDark ? 'text-white' : 'text-blue-700 dark:text-blue-300'}`}>
          {replyTo.senderName}
        </span>
        <span className={`line-clamp-2 whitespace-normal [overflow-wrap:anywhere] ${onDark ? 'text-white/90' : 'text-text-secondary-light dark:text-text-secondary-dark'}`}>
          {Icon && <Icon size={11} className="mr-1 inline -translate-y-px" aria-hidden="true" />}
          {text}
          {a && replyTo.body ? <span className="opacity-80"> · {describeAttachment(a)}</span> : null}
        </span>
      </span>
      {a?.kind === 'image' && <Thumb fileId={a.fileId} />}
    </button>
  );
};
