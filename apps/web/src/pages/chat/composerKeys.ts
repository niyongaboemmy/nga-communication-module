import type React from 'react';

/**
 * Keyboard rules shared by every text box in chat (G-06, G-08).
 *
 * One place, so the main composer, the thread box, the inline thread reply
 * and the edit box can never drift apart again.
 */

/**
 * True while an input method is composing (Chinese, Japanese, Korean, some
 * predictive layouts, dictation). Enter then confirms the candidate; it must
 * not also send. `keyCode === 229` covers browsers that fire keydown before
 * setting `isComposing`.
 */
export function isComposing(e: React.KeyboardEvent | KeyboardEvent): boolean {
  const native = 'nativeEvent' in e ? e.nativeEvent : e;
  return Boolean(native.isComposing) || native.keyCode === 229;
}

/** A device whose primary pointer is a finger. Enter never sends there. */
export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
}

/**
 * Should this Enter submit? On touch: never (there is no Shift key; Enter is
 * the only way to start a new line, so sending is the button's job). On a
 * pointer device: Enter, unless the person turned enter-to-send off; with it
 * off, ⌘/Ctrl+Enter still sends.
 */
export function isSubmitEnter(e: React.KeyboardEvent, enterToSend = true): boolean {
  if (e.key !== 'Enter' || isComposing(e)) return false;
  if (e.metaKey || e.ctrlKey) return true;
  if (e.shiftKey || e.altKey) return false;
  return enterToSend && !isTouchDevice();
}
