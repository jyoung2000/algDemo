// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaveMenu } from './SaveMenu';
import type { PlaylistSummary } from './api';

/**
 * SAVE-MENU-REACH-001 (owner, 2026-11-23): "the playlist pop up and create menu doesn't work on
 * android". Measured on the emulator at the phone's width: the menu opened with its top at -68 CSS px
 * (off the top of the screen), and with the keyboard up its foot sat below the viewport, so nothing
 * appeared to happen. Then the first real tap on "Create and save" was swallowed: the keyboard hid on
 * touch-down, the viewport grew 502 → 780, the button moved out from under the finger and no click was
 * ever generated. These are the two faults, as tests.
 */
const list = (name: string, keys: string[] = []): PlaylistSummary => ({
  id: name, name, created: 1, count: keys.length, unplayed: keys.length, discovery_ready: false,
  items: keys.map((key) => ({ key, track: null, played: false })),
} as unknown as PlaylistSummary);

const edits: { action: string; opts: Record<string, unknown> }[] = [];
vi.mock('./api', async (orig) => {
  const real = await orig<typeof import('./api')>();
  return {
    ...real,
    api: {
      ...real.api,
      playlistEdit: (action: string, opts: Record<string, unknown>) => {
        edits.push({ action, opts });
        return Promise.resolve({ lists: [list(String(opts.name ?? 'Night drive'), ['song'])] });
      },
    },
  };
});

afterEach(cleanup);
beforeEach(() => { edits.length = 0; });

describe('the save menu can be reached on a phone', () => {
  it('scrolls itself into view when it opens, so a menu off the top of the screen is shown', () => {
    const seen: [string, { block?: string } | undefined][] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element, arg?: unknown) { seen.push([String(this.className), arg as { block?: string } | undefined]); };
    render(<SaveMenu songKey="song" title="One More Time" lists={[list('Night drive')]} onLists={() => {}} onClose={() => {}} />);
    expect(seen.some(([cls]) => String(cls).includes('savemenu'))).toBe(true);
    // 'nearest' moves the least: a menu already in view is left where it is.
    expect(seen.some(([, arg]) => arg?.block === 'nearest')).toBe(true);
  });

  it('creates the list on the first press while the keyboard is open, not the second', async () => {
    render(<SaveMenu songKey="song" title="One More Time" lists={[]} onLists={() => {}} onClose={() => {}} />);
    const field = screen.getByLabelText('New list name') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Late night' } });
    const create = screen.getByRole('button', { name: 'Create and save' });
    // A touch that would blur the field and resize the viewport must be refused, so the press lands.
    const down = fireEvent.pointerDown(create);
    expect(down).toBe(false); // preventDefault() was called: the keyboard stays, nothing moves
    fireEvent.click(create);
    await waitFor(() => expect(edits).toEqual([{ action: 'create', opts: { name: 'Late night', key: 'song' } }]));
  });

  it('keeps the keyboard from stealing a tick, a cancel or Done as well', () => {
    render(<SaveMenu songKey="song" title="One More Time" lists={[list('Night drive')]} onLists={() => {}} onClose={() => {}} />);
    for (const name of ['Done']) expect(fireEvent.pointerDown(screen.getByRole('button', { name }))).toBe(false);
    expect(fireEvent.pointerDown(screen.getByRole('checkbox', { name: /Night drive/ }).closest('label')!)).toBe(false);
  });

  it('still closes when a press lands outside it', () => {
    const onClose = vi.fn();
    render(<SaveMenu songKey="song" title="One More Time" lists={[list('Night drive')]} onLists={() => {}} onClose={onClose} />);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});
