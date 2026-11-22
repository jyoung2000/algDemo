// TYPING-CLEAR-001 (owner, 2026-11-21): "ensure the player UI doesnt cover any inputs the user is trying to type in,
// temporarily hide the player to let the user type in inputs if needed, currently the player is ontop of the inputs
// when users try to type on android and it causes them not to be able to input text".
//
// On a phone the docked player and the tab bar are fixed to the bottom of the window. When the keyboard opens Android
// shrinks the window, so both ride up on top of the keyboard and sit over the field being typed in. While a text field
// outside the player has focus on a touch screen, <html> carries `is-typing` and typing.css hides them. They come back
// when the field loses focus, or when the keyboard is put away (Back) while the field keeps focus; tapping the field
// again brings the keyboard back and hides them again.

import './typing.css';

const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);
/** The player and the tab bar themselves: a field inside them never hides them. */
const OWN = '.rail, .side';
/** How much shorter the window must be to count as the keyboard being up, and how close to full height as it gone. */
const OPEN_PX = 120, CLOSED_PX = 40;

export function isTextEntry(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.closest(OWN)) return false;
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLInputElement) return TEXT_TYPES.has((el.getAttribute('type') ?? '').toLowerCase()) && !el.disabled && !el.readOnly;
  return el.isContentEditable;
}

export interface TypingWatch { stop(): void; typing(): boolean }

/** Watches focus and the window height; [touch] says whether this screen types through an on-screen keyboard. */
export function watchTyping(win: Window = window, touch: () => boolean = () => win.matchMedia?.('(pointer: coarse)').matches ?? false): TypingWatch {
  const doc = win.document, root = doc.documentElement;
  let typing = false, keyboardSeen = false;
  const fullHeight = new Map<number, number>(); // the tallest the window has been at each width (a turn changes it)
  const height = () => win.visualViewport?.height ?? win.innerHeight;
  const full = () => { const w = win.innerWidth, h = height(), was = fullHeight.get(w) ?? 0; if (h > was) fullHeight.set(w, h); return Math.max(h, was); };
  const set = (on: boolean) => { typing = on; root.classList.toggle('is-typing', on); };
  const start = () => { if (!touch()) return; full(); keyboardSeen = false; set(true); };

  const onFocusIn = (e: Event) => { if (isTextEntry(e.target as Element)) start(); else if (typing) set(false); };
  // Moving from one field to the next blurs before the next focuses: look again once focus has settled.
  const onFocusOut = () => { win.setTimeout(() => { if (typing && !isTextEntry(doc.activeElement)) set(false); }, 0); };
  const onResize = () => {
    const h = height(), top = full();
    if (!typing) return;
    if (top - h >= OPEN_PX) keyboardSeen = true;
    else if (keyboardSeen && top - h <= CLOSED_PX) { keyboardSeen = false; set(false); } // keyboard put away; field still focused
  };
  // A tap on the focused field after Back raises the keyboard again without a new focus event.
  const onPointer = (e: Event) => { if (!typing && e.target === doc.activeElement && isTextEntry(e.target as Element)) start(); };

  doc.addEventListener('focusin', onFocusIn); doc.addEventListener('focusout', onFocusOut); doc.addEventListener('pointerdown', onPointer, true);
  win.addEventListener('resize', onResize); win.visualViewport?.addEventListener('resize', onResize);
  full();
  if (isTextEntry(doc.activeElement)) start();
  return {
    typing: () => typing,
    stop() {
      doc.removeEventListener('focusin', onFocusIn); doc.removeEventListener('focusout', onFocusOut); doc.removeEventListener('pointerdown', onPointer, true);
      win.removeEventListener('resize', onResize); win.visualViewport?.removeEventListener('resize', onResize);
      set(false);
    },
  };
}
