// @vitest-environment happy-dom
/**
 * SAVE-MENU-STAY-001 (owner, 2026-11-23): "On android adding songs to playlist doesnt work".
 *
 * Measured on the emulator with real taps: the heart opened the playlist menu on a queue row, and about eight
 * seconds later — with no touch at all — the menu was gone. Liking the song had started a queue refresh, the row
 * left the queue, and the menu lived inside that row. A second fault sat beside it: the menu took focus and
 * scrolled itself into view again on EVERY redraw of the page (its effect depended on a callback that is a new
 * function each time), so on a page that redraws several times a second it kept pulling focus and scroll back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Results } from './Results';
import { SaveMenu } from './SaveMenu';
import type { PlaylistSummary, RecItem, Track } from './api';

afterEach(cleanup);

let answer: (() => Promise<{ lists: PlaylistSummary[] }>) | null = null;
vi.mock('./api', async (orig) => {
  const real = await orig<typeof import('./api')>();
  return { ...real, api: { ...real.api, playlistEdit: () => (answer ? answer() : Promise.resolve({ lists: [] })) } };
});

const track = (key: string, title: string): Track =>
  ({ key, title, artists: ['Daft Punk'], artist: 'Daft Punk', duration: 199, artwork: null, isrc: null }) as unknown as Track;
const item = (key: string, title: string): RecItem =>
  ({ rank: 1, track: track(key, title), score: 1, coverage: 1, tier: 'emerging', evidence: 'strong', best_seed: null, reasons: [], uncertainty: [], new_release: false, factors: {}, weights: {}, sources: [], playback: { preview: null, embed: null } }) as unknown as RecItem;
const list = (name: string): PlaylistSummary =>
  ({ id: name, name, created: 1, count: 0, unplayed: 0, discovery_ready: false, items: [] }) as unknown as PlaylistSummary;

const props = (items: RecItem[]) => ({
  seeds: [], onRemoveSeed: () => undefined, onEmphasis: () => undefined, items, focusKey: null, playingKey: null, flags: {},
  onFocus: () => undefined, onPlay: () => undefined, onPlayTrack: () => undefined, onFeedback: () => undefined,
  lists: [list('Night drive')], onLists: () => undefined,
});
const titles = () => [...document.querySelectorAll('ol.recs > li')].map((li) => li.querySelector('.rec__title, .title, strong, b')?.textContent ?? li.textContent?.slice(0, 20));
const rowIds = () => [...document.querySelectorAll('ol.recs > li')].map((li) => li.id);

describe('SAVE-MENU-STAY-001: the playlist menu stays until the listener is done with it', () => {
  it('keeps its row, and the menu, when the queue is refreshed without that song', () => {
    const a = item('a', 'Alpha'), b = item('b', 'Bravo'), c = item('c', 'Charlie'), d = item('d', 'Delta');
    const view = render(createElement(Results, props([a, b, c]) as never));
    fireEvent.click(screen.getByRole('button', { name: /^Like Bravo and choose lists/ }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    const before = rowIds();

    // The refresh the like itself caused: Bravo has left the queue, Delta has arrived, the order changed.
    view.rerender(createElement(Results, props([c, d, a]) as never));
    const menu = screen.getByRole('dialog');
    expect(within(menu).getByRole('checkbox', { name: /Night drive/ })).toBeTruthy();
    // Nothing moved under the finger while the menu is open.
    expect(rowIds()).toEqual(before);

    // Done: now the queue shows as it really is.
    fireEvent.click(within(menu).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rowIds().length).toBe(3);
    expect(rowIds()).not.toEqual(before);
    expect(document.body.textContent).toContain('Delta');
    expect(document.body.textContent).not.toContain('Bravo');
  });

  it('still shows a row\'s newer state while it is held (the song now reads as liked)', () => {
    const a = item('a', 'Alpha'), b = item('b', 'Bravo');
    const view = render(createElement(Results, props([a, b]) as never));
    fireEvent.click(screen.getByRole('button', { name: /^Like Bravo and choose lists/ }));
    view.rerender(createElement(Results, { ...props([b, a]), flags: { b: { like: true } } } as never));
    expect(screen.getByRole('button', { name: /^Liked: choose lists for Bravo/ })).toBeTruthy();
  });
});

describe('SAVE-MENU-STAY-001: the menu takes focus and scrolls once, not on every redraw', () => {
  it('does not pull focus or scroll back when the page redraws around it', () => {
    let scrolls = 0;
    Element.prototype.scrollIntoView = function scrollIntoView() { scrolls++; };
    const lists = [list('Night drive'), list('Gym')];
    // A new onClose function on every draw, exactly as the rows pass it.
    const draw = () => createElement(SaveMenu, { songKey: 'song', title: 'One More Time', lists, onLists: () => undefined, onClose: () => undefined });
    const view = render(draw());
    expect(scrolls).toBe(1);
    const second = screen.getByRole('checkbox', { name: /Gym/ });
    second.focus();
    expect(document.activeElement).toBe(second);
    view.rerender(draw());
    view.rerender(draw());
    expect(scrolls).toBe(1);
    expect(document.activeElement).toBe(second);
  });

  it('still closes on a press outside, with the newest onClose', () => {
    const first = vi.fn(), latest = vi.fn();
    const draw = (onClose: () => void) => createElement(SaveMenu, { songKey: 'song', title: 'One More Time', lists: [list('Night drive')], onLists: () => undefined, onClose });
    const view = render(draw(first));
    view.rerender(draw(latest));
    fireEvent.pointerDown(document.body);
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

describe('SAVE-MENU-STAY-001: a tick shows at once, whatever the engine takes', () => {
  it('ticks the box immediately and says it is saving, then shows what was saved', async () => {
    let finish: (v: { lists: PlaylistSummary[] }) => void = () => undefined;
    answer = () => new Promise((r) => { finish = r; });
    const got: PlaylistSummary[][] = [];
    render(createElement(SaveMenu, { songKey: 'song', title: 'One More Time', lists: [list('Night drive')], onLists: (l: PlaylistSummary[]) => got.push(l), onClose: () => undefined }));
    const box = screen.getByRole('checkbox', { name: /Night drive/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    // The engine has not answered yet.
    expect((screen.getByRole('checkbox', { name: /Night drive/ }) as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector('.savemenu__note')?.textContent).toMatch(/Saving/);
    finish({ lists: [{ ...list('Night drive'), count: 1, items: [{ key: 'song', track: null, played: false }] } as unknown as PlaylistSummary] });
    await waitFor(() => expect(got.length).toBe(1));
  });

  it('puts the box back and says why when the save fails', async () => {
    answer = () => Promise.reject(new Error('The engine did not answer in time.'));
    render(createElement(SaveMenu, { songKey: 'song', title: 'One More Time', lists: [list('Night drive')], onLists: () => undefined, onClose: () => undefined }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Night drive/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/did not answer/));
    expect((screen.getByRole('checkbox', { name: /Night drive/ }) as HTMLInputElement).checked).toBe(false);
  });
});
