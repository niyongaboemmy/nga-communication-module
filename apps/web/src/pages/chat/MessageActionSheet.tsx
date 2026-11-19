import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from 'lucide-react';
import { QUICK_REACTIONS } from '@tupo/shared';
import type { Message } from './types';
import { EmojiPicker } from './EmojiPicker';

/**
 * What a long press on a message opens on a phone (C-02) — the Messenger
 * pattern: the message lifted over a dimmed screen, a row of reactions above
 * it, and labelled actions below in a sheet from the bottom edge.
 *
 * It replaced the desktop hover bar (eleven unlabelled 28 px icons) plus a
 * dropdown that the composer cut in half. Every row here is 52 px tall and
 * named; the sheet sits above the safe area; it closes on a tap outside, on a
 * drag down, on Escape, and on the phone's Back button (a history entry is
 * pushed for it). Focus is held inside while it is open.
 *
 * Flat by the NGA rules: a dim backdrop, no shadows.
 */

export interface SheetAction {
  key: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  onSelect: () => void;
  tone?: 'danger';
}

export const MessageActionSheet: React.FC<{
  message: Message;
  mine: boolean;
  actions: SheetAction[];
  canReact: boolean;
  onReact: (emoji: string) => void;
  onClose: () => void;
}> = ({ message: m, mine, actions, canReact, onReact, onClose }) => {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [dragY, setDragY] = useState(0);
  const drag = useRef<{ y: number; id: number } | null>(null);
  const [picking, setPicking] = useState(false);

  /*
   * The phone's Back closes the sheet, not the conversation behind it: a
   * history entry is pushed once (a second mount — StrictMode — finds it
   * there), and every way of closing goes through `close`, which steps back
   * over it; the `popstate` that follows is what closes the sheet.
   */
  const ours = () => Boolean((window.history.state as { tupoSheet?: boolean } | null)?.tupoSheet);
  useEffect(() => {
    if (!ours()) {
      window.history.pushState({ ...(window.history.state ?? {}), tupoSheet: true }, '');
      navigator.vibrate?.(10);
    }
    const onPop = () => onClose();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [onClose]);
  const close = useCallback(() => { if (ours()) window.history.back(); else onClose(); }, [onClose]);

  // Escape, and focus kept inside while open.
  useEffect(() => {
    const el = sheetRef.current;
    el?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>('button:not([disabled])')];
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  const choose = (fn: () => void) => { close(); requestAnimationFrame(fn); };

  const preview = m.body?.trim()
    || (m.attachments.length ? (m.attachments[0]?.kind === 'image' ? 'Photo' : m.attachments[0]?.name ?? 'Attachment') : '');

  /*
   * The finger that long-pressed is still down when the sheet appears; lifting
   * it makes a click on whatever is now under it — the backdrop (closing the
   * sheet at once) or an action. Clicks count only once a press has started
   * inside the sheet. Keyboard clicks (detail 0) are never held back.
   */
  const armed = useRef(false);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col justify-end"
      role="presentation"
      onPointerDownCapture={() => { armed.current = true; }}
      onClickCapture={(e) => { if (!armed.current && e.detail !== 0) { e.preventDefault(); e.stopPropagation(); } }}
    >
      <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={close} aria-hidden="true" />

      {/* The message, lifted, with reactions above it. */}
      <div className={`relative mb-2 flex flex-col px-4 ${mine ? 'items-end' : 'items-start'}`}>
        {canReact && (
          <div className="mb-2 flex items-center gap-1 rounded-full bg-white px-2 py-1 dark:bg-elevated-dark" role="group" aria-label="React">
            {QUICK_REACTIONS.map((e) => (
              <button
                key={e}
                onClick={() => choose(() => onReact(e))}
                aria-label={`React with ${e}`}
                className="grid h-11 w-11 place-items-center rounded-full text-2xl leading-none active:scale-110 motion-reduce:active:scale-100"
              >
                {e}
              </button>
            ))}
            <button
              onClick={() => setPicking((v) => !v)}
              aria-label="More reactions"
              className="grid h-11 w-11 place-items-center rounded-full text-text-secondary-light dark:text-text-secondary-dark"
            >
              <Plus size={20} />
            </button>
          </div>
        )}
        {picking && (
          <div className="relative w-full">
            <EmojiPicker align="up" onPick={(e) => choose(() => onReact(e))} onClose={() => setPicking(false)} />
          </div>
        )}
        {preview && (
          <div
            className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm [overflow-wrap:anywhere] ${
              mine ? 'bg-blue-600 text-white' : 'bg-white text-text-primary-light dark:bg-elevated-dark dark:text-text-primary-dark'
            }`}
          >
            <span className="line-clamp-4">{preview}</span>
          </div>
        )}
      </div>

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Message actions"
        className="pb-safe relative max-h-[60vh] overflow-y-auto rounded-t-3xl bg-white animate-panel-in-up dark:bg-chrome-dark"
        style={{ transform: dragY ? `translateY(${dragY}px)` : undefined, transition: drag.current ? 'none' : 'transform 150ms ease-out' }}
      >
        {/* Drag down to dismiss. */}
        <div
          className="flex h-6 touch-none items-center justify-center"
          onPointerDown={(e) => { drag.current = { y: e.clientY, id: e.pointerId }; e.currentTarget.setPointerCapture?.(e.pointerId); }}
          onPointerMove={(e) => { if (drag.current && e.pointerId === drag.current.id) setDragY(Math.max(0, e.clientY - drag.current.y)); }}
          onPointerUp={() => { const far = dragY > 80; drag.current = null; if (far) close(); else setDragY(0); }}
          onPointerCancel={() => { drag.current = null; setDragY(0); }}
          aria-hidden="true"
        >
          <span className="h-1 w-10 rounded-full bg-slate-300 dark:bg-slate-600" />
        </div>
        <ul className="px-2 pb-2">
          {actions.map((a) => (
            <li key={a.key}>
              <button
                onClick={() => choose(a.onSelect)}
                className={`flex min-h-[52px] w-full items-center gap-4 rounded-xl px-4 text-left text-[15px] font-medium active:bg-surface-light dark:active:bg-surface-dark ${
                  a.tone === 'danger' ? 'text-red-600 dark:text-red-400' : 'text-text-primary-light dark:text-text-primary-dark'
                }`}
              >
                <a.icon size={20} className={a.tone === 'danger' ? '' : 'text-text-secondary-light dark:text-text-secondary-dark'} />
                {a.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
};
