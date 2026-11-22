// @vitest-environment happy-dom
// TYPING-CLEAR-001 (owner, 2026-11-21): "currently the player is ontop of the inputs when users try to type on android
// and it causes them not to be able to input text".
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isTextEntry, watchTyping, type TypingWatch } from './typing-hides-player';

let w: TypingWatch | null = null;
const tick = () => new Promise(r => setTimeout(r, 5));
const on = () => document.documentElement.classList.contains('is-typing');
function setHeight(h: number) { Object.defineProperty(window, 'innerHeight', { value: h, configurable: true }); window.dispatchEvent(new Event('resize')); }
beforeEach(() => {
  document.body.innerHTML = `<main><input id="q" type="search"><input id="n" type="text"><textarea id="t"></textarea><input id="r" type="range"><input id="c" type="checkbox"><button id="b">Go</button><input id="ro" readonly></main>
    <aside class="rail"><input id="inplayer" type="text"></aside><nav class="side"><input id="intabs"></nav>`;
  Object.defineProperty(window, 'innerWidth', { value: 412, configurable: true }); setHeight(900);
});
afterEach(() => { w?.stop(); w = null; (document.activeElement as HTMLElement | null)?.blur?.(); });
const el = (id: string) => document.getElementById(id) as HTMLElement;

describe('the player steps aside while typing on a phone (TYPING-CLEAR-001)', () => {
  it('counts text fields only, never sliders, boxes, buttons, read-only fields or fields in the player itself', () => {
    expect(['q', 'n', 't'].map(id => isTextEntry(el(id)))).toEqual([true, true, true]);
    expect(['r', 'c', 'b', 'ro', 'inplayer', 'intabs'].map(id => isTextEntry(el(id)))).toEqual([false, false, false, false, false, false]);
  });
  it('hides the player while a search field has focus and shows it again when the field is left', async () => {
    w = watchTyping(window, () => true);
    el('q').focus(); expect(on()).toBe(true);
    el('q').blur(); await tick(); expect(on()).toBe(false);
  });
  it('stays hidden while moving from one field to the next', async () => {
    w = watchTyping(window, () => true);
    el('q').focus(); el('n').focus(); await tick(); expect(on()).toBe(true);
    el('b').focus(); await tick(); expect(on()).toBe(false);
  });
  it('comes back when the keyboard is put away with Back, and hides again when the field is tapped', async () => {
    w = watchTyping(window, () => true);
    el('q').focus(); setHeight(520); expect(on()).toBe(true);   // keyboard up
    setHeight(900); expect(on()).toBe(false);                    // keyboard down, the field still focused
    expect(document.activeElement).toBe(el('q'));
    el('q').dispatchEvent(new Event('pointerdown', { bubbles: true })); expect(on()).toBe(true);
  });
  it('a small height change (a toolbar) is not the keyboard going away', () => {
    w = watchTyping(window, () => true);
    el('q').focus(); setHeight(870); expect(on()).toBe(true);
  });
  it('never hides on a mouse-and-keyboard screen', () => {
    w = watchTyping(window, () => false);
    el('q').focus(); expect(on()).toBe(false);
  });
  it('hides nothing for a field inside the player (naming a playlist from the player)', () => {
    w = watchTyping(window, () => true);
    el('inplayer').focus(); expect(on()).toBe(false);
  });
  it('the sheet hides the docked player and the tab bar on phone widths only, and the app loads it', () => {
    const css = readFileSync(`${process.cwd()}/src/typing.css`, 'utf8').replace(/\r/g, '');
    expect(css).toMatch(/@media \(max-width: 899px\)[\s\S]*html\.is-typing \.rail,\s*html\.is-typing \.side \{ display: none !important; \}/);
    expect(readFileSync(`${process.cwd()}/src/main.tsx`, 'utf8')).toMatch(/import \{ watchTyping \} from '\.\/typing-hides-player';[\s\S]*watchTyping\(\);/);
    expect(readFileSync(`${process.cwd()}/src/typing-hides-player.ts`, 'utf8')).toMatch(/^import '\.\/typing\.css';$/m);
  });
});
