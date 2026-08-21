import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Lock, Send, Users } from 'lucide-react';
import type { MeetChatMessage, MeetParticipant } from '@tupo/shared';
import { Avatar } from '../../../components/ui';
import { PanelShell, PanelEmpty } from './Shell';

/**
 * In-meeting chat, as threads rather than one stream.
 *
 * A single feed with a "send to" dropdown technically supports private
 * messages, but nobody can follow one: replies to a private message land
 * interleaved with the room, and the only way to know a message was private is
 * to read the label on each line. So chat is organised the way people already
 * expect — a list of conversations, one per person, plus the room.
 *
 * The wire format is unchanged: a message with `toParticipantId` is private and
 * the server only ever delivers it to its two ends. This is purely how it is
 * presented.
 */

export interface ChatPanelProps {
  messages: MeetChatMessage[];
  participants: MeetParticipant[];
  you: MeetParticipant | null;
  allowed: boolean;
  onClose: () => void;
  onSend: (body: string, toParticipantId?: string) => void;
}

/** `null` is the room; a participant id is a private thread with that person. */
type ThreadKey = string | null;

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages, participants, you, allowed, onClose, onSend,
}) => {
  const [thread, setThread] = useState<ThreadKey>(null);
  const [draft, setDraft] = useState('');
  const [readCounts, setReadCounts] = useState<Record<string, number>>({});
  const endRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  /** The other end of a private message, whichever side we are on. */
  const counterpart = (m: MeetChatMessage): ThreadKey => {
    if (!m.toParticipantId) return null;
    return m.participantId === you?.id ? m.toParticipantId : m.participantId;
  };

  const threads = useMemo(() => {
    const grouped = new Map<ThreadKey, MeetChatMessage[]>([[null, []]]);
    for (const m of messages) {
      const key = counterpart(m);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(m);
      else grouped.set(key, [m]);
    }
    return grouped;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, you?.id]);

  const visible = threads.get(thread) ?? [];
  const threadKey = thread ?? 'room';

  // Opening a thread marks it read.
  useEffect(() => {
    setReadCounts((r) => ({ ...r, [threadKey]: visible.length }));
  }, [threadKey, visible.length]);

  useEffect(() => {
    if (pinnedToBottom.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [visible.length, thread]);

  const unreadFor = (key: ThreadKey) => {
    const list = threads.get(key) ?? [];
    return Math.max(0, list.length - (readCounts[key ?? 'room'] ?? 0));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    onSend(body, thread ?? undefined);
    setDraft('');
    pinnedToBottom.current = true;
  };

  const other = thread ? participants.find((p) => p.id === thread) : null;
  const others = participants.filter((p) => p.id !== you?.id);

  /* ---- thread list ---- */
  if (thread === null && !allowed) {
    return (
      <PanelShell title="Chat" subtitle="Chat is disabled by the host" onClose={onClose}>
        <PanelEmpty title="Chat is off." hint="The host has turned off chat for this meeting." />
      </PanelShell>
    );
  }

  return (
    <PanelShell
      title={other ? other.name : 'Chat'}
      subtitle={other
        ? 'Private — only the two of you can see this'
        : `Everyone · ${participants.length} in the meeting`}
      onClose={onClose}
      footer={
        <form onSubmit={submit} className="space-y-2">
          {other && (
            <p className="flex items-center gap-1 text-[11px] text-amber-300/80">
              <Lock size={10} /> Private to {other.name}
            </p>
          )}
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={!allowed}
              placeholder={other ? `Message ${other.name}…` : 'Message everyone…'}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-blue-500 focus:outline-none disabled:opacity-40"
            />
            <button
              type="submit"
              disabled={!allowed || !draft.trim()}
              aria-label="Send"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-blue-600 text-white transition-colors duration-150 hover:bg-blue-500 disabled:opacity-30"
            >
              <Send size={15} />
            </button>
          </div>
        </form>
      }
    >
      {/* Thread switcher. Horizontal so it costs one row, not a sidebar. */}
      <div className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-white/10 bg-slate-900/95 px-2 py-2 backdrop-blur-sm">
        {thread !== null && (
          <button
            onClick={() => setThread(null)}
            aria-label="Back to everyone"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/60 hover:bg-white/10 hover:text-white"
          >
            <ArrowLeft size={14} />
          </button>
        )}
        <ThreadChip
          label="Everyone"
          icon={<Users size={12} />}
          active={thread === null}
          unread={thread === null ? 0 : unreadFor(null)}
          onClick={() => setThread(null)}
        />
        {others.map((p) => (
          <ThreadChip
            key={p.id}
            label={p.name}
            avatar={<Avatar name={p.name} src={p.avatarUrl ?? undefined} size={18} />}
            active={thread === p.id}
            unread={thread === p.id ? 0 : unreadFor(p.id)}
            onClick={() => setThread(p.id)}
          />
        ))}
      </div>

      <div
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="px-3 py-2"
      >
        {visible.length === 0 ? (
          <PanelEmpty
            title={other ? `No messages with ${other.name} yet.` : 'No messages yet.'}
            hint={other
              ? 'Only the two of you will see this conversation.'
              : 'Messages here stay with the meeting.'}
          />
        ) : (
          <ul className="space-y-2.5">
            {visible.map((m) => {
              const isMine = m.participantId === you?.id;
              return (
                <li key={m.id} className={isMine ? 'text-right' : ''}>
                  <div
                    className={
                      'inline-block max-w-[85%] rounded-2xl px-3 py-2 text-left ' +
                      (m.toParticipantId
                        ? 'border border-amber-500/25 bg-amber-500/10'
                        : isMine ? 'bg-blue-600/25' : 'bg-white/5')
                    }
                  >
                    {/* In a private thread the names are already established by
                        the header, so only the room view repeats them. */}
                    {!other && (
                      <div className="mb-0.5 flex items-center gap-1.5">
                        <span className="text-[11px] font-semibold text-white/70">
                          {isMine ? 'You' : m.senderName}
                        </span>
                        <span className="ml-auto text-[10px] text-white/30">{timeOf(m.createdAt)}</span>
                      </div>
                    )}
                    <p className="whitespace-pre-wrap break-words text-sm text-white/90">{m.body}</p>
                    {other && (
                      <span className="mt-0.5 block text-[10px] text-white/25">{timeOf(m.createdAt)}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div ref={endRef} />
      </div>
    </PanelShell>
  );
};

const ThreadChip: React.FC<{
  label: string; icon?: React.ReactNode; avatar?: React.ReactNode;
  active: boolean; unread: number; onClick: () => void;
}> = ({ label, icon, avatar, active, unread, onClick }) => (
  <button
    onClick={onClick}
    className={
      'relative flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1.5 text-xs font-medium ' +
      'transition-colors duration-150 ' +
      (active ? 'bg-blue-600 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white')
    }
  >
    {avatar ?? icon}
    <span className="max-w-[7rem] truncate">{label}</span>
    {unread > 0 && (
      <span className="grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
        {unread > 9 ? '9+' : unread}
      </span>
    )}
  </button>
);
