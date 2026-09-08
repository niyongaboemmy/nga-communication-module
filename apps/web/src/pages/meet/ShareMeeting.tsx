import React, { useEffect, useRef, useState } from 'react';
import {
  Check, Copy, Link2, Mail, MessageCircle, Share2, CalendarPlus, X,
} from 'lucide-react';

/**
 * Share a meeting.
 *
 * The important thing here is not the number of buttons — it is that every
 * route hands over the *same* two facts: the link and the code. People forward
 * meeting details through whatever they already use, and a share sheet that
 * only offers one channel just means they retype it into another, which is
 * where the typo comes from.
 *
 * Two deliberate restraints:
 *
 *  - The link is built from `window.location.origin`, never from a value the
 *    server sends. A "share this" feature that renders a server-supplied URL
 *    is a redirect waiting to be abused.
 *  - Nothing here changes who may join. Sharing a link to an invite-only
 *    meeting does not admit the recipient, and the panel says so rather than
 *    letting someone assume otherwise.
 */

export interface ShareMeetingProps {
  meetingId: string;
  joinCode: string;
  title: string;
  startsAt?: string | null;
  /** How the meeting decides who gets in, so the panel can be honest about it. */
  admission?: 'invited' | 'permission' | 'authenticated' | 'public';
  onClose: () => void;
}

const ADMISSION_NOTE: Record<string, string> = {
  invited: 'Only the people you invited can use this link. Sharing it more widely will not let anyone else in.',
  permission: 'Anyone signed in to Tupo who opens this link can ask to join.',
  authenticated: 'Anyone signed in to Tupo can join with this link.',
  public: 'Anyone with this link can join, including people without an account.',
};

/** An .ics file, built here — a calendar invitation with no server round trip. */
function icsFor(opts: { title: string; url: string; startsAt?: string | null }): string {
  const stamp = (d: Date) => `${d.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
  const start = opts.startsAt ? new Date(opts.startsAt) : new Date();
  const end = new Date(start.getTime() + 60 * 60_000);
  // Folded per RFC 5545: literal newlines inside a field would end it early.
  const escape = (t: string) => t.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tupo//Meet//EN', 'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${escape(opts.title)}`,
    `DESCRIPTION:${escape(`Join the meeting: ${opts.url}`)}`,
    `URL:${opts.url}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

export const ShareMeeting: React.FC<ShareMeetingProps> = ({
  meetingId, joinCode, title, startsAt, admission = 'permission', onClose,
}) => {
  const [copied, setCopied] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  /*
   * A public meeting gets the guest link, everything else gets the in-app one.
   *
   * `/app/*` is behind the signed-in guard, so handing a public link to
   * somebody without an account bounced them to the sign-in page — the one
   * thing the panel promises will not happen. `/meet/:code` is the only route
   * that renders without a session, and the join code is what a guest can
   * also type by hand, so it is the better identifier here in any case.
   */
  const url = admission === 'public'
    ? `${window.location.origin}/meet/${joinCode}`
    : `${window.location.origin}/app/meet/${meetingId}`;
  const invitation =
    `${title}\n\nJoin: ${url}\nMeeting code: ${joinCode}`;

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async (what: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1800);
    } catch {
      setCopied('failed');
    }
  };

  /* The OS share sheet, where there is one. This is the route people actually
   * want on a phone, because it reaches the app they were already going to
   * paste into. */
  const nativeShare = async () => {
    if (!navigator.share) return;
    try {
      await navigator.share({ title, text: invitation, url });
    } catch {
      // Cancelling the sheet throws. That is not an error worth reporting.
    }
  };

  const downloadIcs = () => {
    const blob = new Blob([icsFor({ title, url, startsAt })], { type: 'text/calendar' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `${title.replace(/[^\w -]/g, '').trim() || 'meeting'}.ics`;
    a.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Share this meeting"
      className="fixed inset-0 z-[100] grid place-items-center bg-black/50 p-4 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="animate-pop w-full max-w-md rounded-2xl border border-border-light bg-white p-4 dark:border-border-dark dark:bg-elevated-dark"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              <Share2 size={15} /> Share this meeting
            </h2>
            <p className="mt-0.5 truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">
              {title}
            </p>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-text-secondary-light transition-colors duration-150 hover:bg-surface-light hover:text-text-primary-light dark:hover:bg-white/5 dark:hover:text-text-primary-dark"
          >
            <X size={15} />
          </button>
        </div>

        {/* The link, and the code, because people use both — a code is what
            you read down a phone, a link is what you paste. */}
        <div className="space-y-2">
          <CopyRow
            icon={<Link2 size={14} />}
            value={url}
            mono={false}
            copied={copied === 'link'}
            onCopy={() => void copy('link', url)}
            label="Copy link"
          />
          <CopyRow
            icon={<span className="text-[10px] font-semibold uppercase">code</span>}
            value={joinCode}
            mono
            copied={copied === 'code'}
            onCopy={() => void copy('code', joinCode)}
            label="Copy code"
          />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {typeof navigator !== 'undefined' && 'share' in navigator && (
            <Action icon={<Share2 size={15} />} label="Share…" onClick={() => void nativeShare()} />
          )}
          <Action
            icon={<Mail size={15} />}
            label="Email"
            href={`mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(invitation)}`}
          />
          <Action
            icon={<MessageCircle size={15} />}
            label="WhatsApp"
            href={`https://wa.me/?text=${encodeURIComponent(invitation)}`}
          />
          <Action
            icon={<CalendarPlus size={15} />}
            label="Calendar file"
            onClick={downloadIcs}
          />
          <Action
            icon={<Copy size={15} />}
            label="Copy invite"
            onClick={() => void copy('invite', invitation)}
            active={copied === 'invite'}
          />
        </div>

        {copied === 'failed' && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            The browser would not give access to the clipboard — select the link above and copy it.
          </p>
        )}

        {/* Sharing a link is not the same as granting access, and the two get
            confused constantly. */}
        <p className="mt-3 border-t border-border-light pt-3 text-xs leading-relaxed text-text-secondary-light dark:border-border-dark/60 dark:text-text-secondary-dark">
          {ADMISSION_NOTE[admission] ?? ADMISSION_NOTE.permission}
        </p>
      </div>
    </div>
  );
};

const CopyRow: React.FC<{
  icon: React.ReactNode; value: string; mono: boolean; copied: boolean;
  label: string; onCopy: () => void;
}> = ({ icon, value, mono, copied, label, onCopy }) => (
  <div className="flex items-center gap-2 rounded-xl border border-border-light bg-surface-light px-3 py-2 dark:border-border-dark/60 dark:bg-white/[0.03]">
    <span className="shrink-0 text-text-secondary-light dark:text-text-secondary-dark">{icon}</span>
    <span className={
      'min-w-0 flex-1 truncate text-xs text-text-primary-light dark:text-text-primary-dark ' +
      (mono ? 'font-mono' : '')
    }>
      {value}
    </span>
    <button
      type="button"
      onClick={onCopy}
      aria-label={label}
      className="flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-blue-600 transition-colors duration-150 hover:bg-blue-500/10 dark:text-blue-400"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  </div>
);

const Action: React.FC<{
  icon: React.ReactNode; label: string; onClick?: () => void; href?: string; active?: boolean;
}> = ({ icon, label, onClick, href, active }) => {
  const className =
    'flex flex-col items-center justify-center gap-1 rounded-xl border px-2 py-3 text-xs font-medium ' +
    'transition-colors duration-150 ' +
    (active
      ? 'border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-300'
      : 'border-border-light text-text-secondary-light hover:border-blue-300 hover:bg-surface-light hover:text-text-primary-light dark:border-border-dark/60 dark:text-text-secondary-dark dark:hover:border-blue-800 dark:hover:bg-white/[0.03] dark:hover:text-text-primary-dark');

  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {icon}{label}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={className}>{icon}{label}</button>
  );
};

export default ShareMeeting;
