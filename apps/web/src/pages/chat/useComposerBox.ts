import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { drafts, useDraft } from './drafts';
import { isSubmitEnter } from './composerKeys';
import { noteCommit, noteKeystroke } from '../../lib/perf';

/**
 * The composer core (chat experience plan §4.3) — one behaviour for every box
 * people type a message into: the main composer, the thread panel, the inline
 * thread reply.
 *
 *  - The text lives in the draft store under `draftKey`, so a keystroke
 *    re-renders only this box (G-02) and survives a reload (G-09).
 *  - Enter follows composerKeys: never during IME composition (G-06), never on
 *    touch, ⌘/Ctrl+Enter always.
 *  - Auto-grow uses CSS `field-sizing: content` where the browser has it; the
 *    measuring fallback only runs elsewhere.
 *  - Typing is announced while there is text and withdrawn the moment the box
 *    empties, loses focus, or the person moves on (G-11).
 *  - `takeForSend` empties the box at send time and `restore` puts the text
 *    back on failure, only into an empty box (G-03).
 */

const FIELD_SIZING = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
  && CSS.supports('field-sizing', 'content');

export interface ComposerBoxOptions {
  draftKey: string;
  /** Max height before the box scrolls. */
  maxHeightPx?: number;
  enterToSend?: boolean;
  onSubmit: () => void;
  /** Announce / withdraw typing for this box. */
  onTyping?: () => void;
  onTypingStop?: () => void;
}

export function useComposerBox(o: ComposerBoxOptions) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const value = useDraft(o.draftKey);
  const opts = useRef(o);
  opts.current = o;
  const max = o.maxHeightPx ?? 160;

  const setValue = useCallback((text: string) => drafts.set(opts.current.draftKey, text), []);

  // Auto-grow fallback; also the end of the keystroke measurement.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !FIELD_SIZING) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    }
    noteCommit();
  }, [value, max]);

  // Moving to another conversation or thread: save what was there, stop typing.
  useEffect(() => {
    const key = o.draftKey;
    return () => {
      drafts.saveNow(key);
      opts.current.onTypingStop?.();
    };
  }, [o.draftKey]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    noteKeystroke();
    const text = e.target.value;
    drafts.set(opts.current.draftKey, text);
    if (text) opts.current.onTyping?.();
    else opts.current.onTypingStop?.();
  }, []);

  const onBlur = useCallback(() => {
    drafts.saveNow(opts.current.draftKey);
    opts.current.onTypingStop?.();
  }, []);

  /** Handles submit-Enter; returns true when it did, so callers can stop. */
  const handleSubmitKey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!isSubmitEnter(e, opts.current.enterToSend ?? true)) return false;
    e.preventDefault();
    opts.current.onSubmit();
    return true;
  }, []);

  /** Empty the box for a send; returns the text that was there. */
  const takeForSend = useCallback((): string => {
    const text = drafts.get(opts.current.draftKey);
    drafts.end(opts.current.draftKey, text);
    opts.current.onTypingStop?.();
    return text;
  }, []);

  /** A send failed: put the text back, unless something new is already there. */
  const restore = useCallback((text: string) => {
    if (!drafts.get(opts.current.draftKey).trim()) drafts.set(opts.current.draftKey, text);
  }, []);

  const textareaProps = {
    ref,
    value,
    onChange,
    onBlur,
    'data-draft-key': o.draftKey,
    style: FIELD_SIZING ? ({ fieldSizing: 'content', maxHeight: max } as React.CSSProperties) : undefined,
  };

  return { ref, value, setValue, onChange, onBlur, handleSubmitKey, takeForSend, restore, textareaProps };
}
