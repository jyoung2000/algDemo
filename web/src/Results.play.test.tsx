// @vitest-environment happy-dom
/**
 * QUEUE-PLAY-001: every song in the list the player is working through must offer Play.
 *
 * Found on the Android build: queue rows 80-82 ("Dr. Cooper - Ich weiss", "Se Me Habia Olvidado")
 * showed like, dislike, download, hide and Why? — and no Play. The rows were numbered members of
 * the queue the player plays from, so the listener could see a song, be told it is a 100% fit, and
 * have no way to start it.
 *
 * The cause is that "playable" asked whether a streaming preview or an embed exists. Inside the
 * Windows and Android apps neither is used: the player looks the song up and downloads the full
 * track to its own deck (Player.tsx mode 'local'), which needs nothing but the track itself. A
 * song with no Deezer preview therefore plays perfectly and was still presented as unplayable.
 *
 * A plain browser has no downloader, so there the old gate is the honest one.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { Results } from './Results';
import { canPlayHere } from './util';
import type { RecItem, Playback, Track } from './api';

const native = (on: boolean) => {
  if (on) (window as unknown as { AirwaveNative: unknown }).AirwaveNative = { downloads: () => undefined };
  else delete (window as unknown as { AirwaveNative?: unknown }).AirwaveNative;
};

const track = (key: string, title: string): Track =>
  ({ key, title, artists: ['Megaloh'], artist: 'Megaloh', duration: 199, artwork: null, isrc: null }) as unknown as Track;

/** A discovery row with no streaming preview and no embed — exactly the rows in the report. */
const item = (key: string, title: string, playback: Partial<Playback> = {}): RecItem =>
  ({
    rank: 80,
    track: track(key, title),
    score: 1,
    coverage: 1,
    tier: 'emerging',
    evidence: 'strong',
    best_seed: null,
    reasons: [{ factor: 'taste', text: 'Fits your listening: Electro songs you have finished.', weight: 1 }],
    uncertainty: [],
    new_release: false,
    factors: {},
    weights: {},
    sources: [],
    playback: { preview: null, embed: null, ...playback } as Playback,
  }) as unknown as RecItem;

const view = (items: RecItem[]) =>
  render(
    createElement(Results, {
      seeds: [],
      onRemoveSeed: () => undefined,
      onEmphasis: () => undefined,
      items,
      focusKey: null,
      playingKey: null,
      flags: {},
      onFocus: () => undefined,
      onPlay: vi.fn(),
      onPlayTrack: () => undefined,
      onFeedback: () => undefined,
      onDownload: () => undefined,
    }),
  );

afterEach(() => {
  cleanup();
  native(false);
});

describe('every song in the queue offers Play (QUEUE-PLAY-001)', () => {
  it('gives a preview-less queue row a Play button inside the app, because the app fetches the full song', () => {
    native(true);
    view([item('k1', 'Dr. Cooper - Ich weiss')]);
    // Two controls carry it: the artwork and the button in the action row.
    expect(screen.getAllByRole('button', { name: 'Play Dr. Cooper - Ich weiss' }).length).toBe(2);
  });

  it('never tells the listener a queued song "has no player here" inside the app', () => {
    native(true);
    view([item('k2', 'Se Me Habia Olvidado')]);
    expect(screen.queryByLabelText('Se Me Habia Olvidado has no player here')).toBeNull();
  });

  it('leaves the artwork of a queued song pressable, not disabled, inside the app', () => {
    native(true);
    view([item('k3', 'Dr. Cooper - Ich weiss - Instrumental')]);
    const art = screen
      .getAllByRole('button', { name: 'Play Dr. Cooper - Ich weiss - Instrumental', hidden: true })
      .find((b) => b.classList.contains('rec__art')) as HTMLButtonElement | undefined;
    expect(art, 'the artwork must still be the big play target').toBeTruthy();
    expect(art?.disabled).toBe(false);
  });

  it('gives every row of a multi-song queue its own Play, not just the ones with previews', () => {
    native(true);
    view([
      item('a', 'Ich weiss'),
      item('b', 'Instrumental', { preview: 'https://example.test/p.mp3' }),
      item('c', 'Olvidado'),
    ]);
    const plays = screen.getAllByRole('button', { name: /^Play / }).length;
    // Two controls per row (artwork + the action button), so three songs are six.
    expect(plays).toBe(6);
  });

  it('still admits a plain browser cannot play a preview-less song, instead of offering a dead button', () => {
    native(false);
    view([item('k4', 'Olvidado')]);
    expect(screen.queryByRole('button', { name: 'Play Olvidado' })).toBeNull();
    expect(screen.getByLabelText('Olvidado has no player here')).toBeTruthy();
  });

  it('plays a preview in a plain browser, where a preview is all there is', () => {
    native(false);
    view([item('k5', 'Ich weiss', { preview: 'https://example.test/p.mp3' })]);
    expect(screen.getAllByRole('button', { name: 'Play Ich weiss', hidden: true }).length).toBeGreaterThan(0);
  });
});

describe('the predicate behind it (QUEUE-PLAY-001)', () => {
  it('says yes to any song inside the app, preview or not', () => {
    native(true);
    expect(canPlayHere({ preview: null, embed: null })).toBe(true);
  });

  it('says no to a preview-less song in a plain browser, where nothing can fetch it', () => {
    native(false);
    expect(canPlayHere({ preview: null, embed: null })).toBe(false);
  });

  it('still says yes in a plain browser when there is a preview or an embed to play', () => {
    native(false);
    expect(canPlayHere({ preview: 'https://example.test/p.mp3', embed: null })).toBe(true);
    expect(canPlayHere({ preview: null, embed: { provider: 'ytmusic', url: 'https://example.test/e' } })).toBe(true);
  });
});

// A source guard, in this repo's idiom (see song-card.test.ts): the three gates that decide whether
// a song can be started must all go through the predicate. The bug was one raw streaming check
// copied into three places, so a future copy is what this catches.
describe('no gate decides playability from a streaming preview again (QUEUE-PLAY-001)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of ['Results.tsx', 'App.tsx']) {
    it(`${file} asks canPlayHere, never playback.preview || playback.embed`, () => {
      const src = readFileSync(join(here, file), 'utf8');
      expect(src).toMatch(/canPlayHere\(/);
      expect(src, 'a raw preview-or-embed gate decides playability again').not.toMatch(/playback\.preview \|\| [\w.]*playback\.embed/);
      expect(src).not.toMatch(/pb\.preview \|\| pb\.embed/);
    });
  }
});
