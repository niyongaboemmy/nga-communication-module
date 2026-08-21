import React, { useEffect, useState } from 'react';
import { Bookmark, X, Hash, MessageSquare } from 'lucide-react';
import { Avatar, IconButton, Skeleton, EmptyState } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { useChat } from './ChatProvider';
import { RichText } from './RichText';
import { shortStamp } from './data';
import * as chatApi from './api';

/**
 * Saved items (FR-MSG-12) — a personal reading list across every conversation.
 *
 * Each entry carries where it came from and jumps back to it in place. A saved
 * message shown without its context is a sentence you cannot act on, which is
 * how "save for later" becomes a list nobody opens twice.
 *
 * The server re-checks membership on read, so a message saved from a channel
 * someone has since left simply stops appearing — the bookmark cannot outlive
 * the access.
 */

export const SavedItems: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { user } = useAuth();
  const { setActiveId, jumpTo, save } = useChat();
  const [items, setItems] = useState<chatApi.SavedItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    chatApi.listSaved()
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = async (item: chatApi.SavedItem) => {
    setActiveId(item.message.conversationId);
    onClose();
    // After the switch, so the target conversation's log is the one being
    // searched for the message.
    setTimeout(() => void jumpTo(item.message.id), 350);
  };

  const unsave = async (item: chatApi.SavedItem) => {
    setItems((prev) => prev.filter((i) => i.message.id !== item.message.id));
    try {
      await chatApi.setSaved(item.message.conversationId, item.message.id, false);
      // Keep the message row in the open conversation in step, if it is loaded.
      await save(item.message.id, false).catch(() => {});
    } catch { /* it reappears on the next open */ }
  };

  return (
    <aside
      aria-label="Saved items"
      className="flex h-full min-h-0 w-full flex-col border-l border-border-light bg-white dark:border-border-dark/30 dark:bg-chrome-dark"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 dark:border-border-dark/30">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
          <Bookmark size={15} /> Saved items
        </h2>
        <IconButton label="Close saved items" onClick={onClose}><X size={18} /></IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="space-y-2 p-1" aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Bookmark size={22} />}
            title="Nothing saved yet"
            hint="Save a message from its hover menu to keep it here."
          />
        ) : (
          <ul className="space-y-1.5">
            {items.map((item) => (
              <li
                key={item.message.id}
                className="group rounded-xl border border-border-light bg-surface-light p-2.5 transition-colors duration-150 hover:bg-white dark:border-border-dark/40 dark:bg-elevated-dark/40 dark:hover:bg-elevated-dark"
              >
                <div className="mb-1 flex items-center gap-1.5">
                  {item.conversationType === 'dm'
                    ? <MessageSquare size={11} className="shrink-0 opacity-60" />
                    : <Hash size={11} className="shrink-0 opacity-60" />}
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text-secondary-light dark:text-text-secondary-dark">
                    {item.conversationName}
                  </span>
                  <span className="shrink-0 text-[10px] text-text-secondary-light dark:text-text-secondary-dark">
                    {shortStamp(item.message.createdAt)}
                  </span>
                  <IconButton
                    label={`Remove saved message from ${item.message.senderName}`}
                    size="sm"
                    onClick={() => void unsave(item)}
                  >
                    <X size={12} />
                  </IconButton>
                </div>

                <button onClick={() => void open(item)} className="flex w-full gap-2 text-left">
                  <Avatar
                    name={item.message.senderName}
                    src={item.message.senderAvatarUrl ?? undefined}
                    size={26}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold text-text-primary-light dark:text-text-primary-dark">
                      {item.message.senderId === user?.id ? 'You' : item.message.senderName}
                    </span>
                    <span className="mt-0.5 line-clamp-3 block text-xs text-text-secondary-light dark:text-text-secondary-dark">
                      {item.message.body
                        ? <RichText text={item.message.body} names={item.message.mentionNames} />
                        : `${item.message.attachments.length} attachment(s)`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
};
