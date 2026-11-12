// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Results } from './Results';
import type { RecItem, Track } from './api';

/**
 * SEED-DUPE-001. Owner: "Ensure adding a starting song the recommendation engine doesnt recommend
 * the same song again."
 *
 * Since QUEUE-SEED-001 the row's + button both queues a song and makes it a starting song, so the
 * same recording was drawn twice: once as the "Starting song" row and once as queue entry 1.
 * One song, one row. The queue row is the one that stays - it is the playable one, with its rank,
 * cache state and feedback - and it carries the starting-song marker and controls instead.
 */
const track = (over: Partial<Track> = {}): Track => ({
  key: 'k1', id: 'yt:1', provider: 'ytmusic', platform_id: '1',
  title: 'tell me what you want', artists: ['Sasha Keable'], album: null, artwork: null,
  duration: 237, isrc: null, url: 'https://music.youtube.com/watch?v=1', source: null,
  tags: [], explicit: false, release: null, ...over,
} as Track);

const item = (t: Track): RecItem => ({
  track: t, rank: 1, score: 1, tier: 'related', evidence: 'test',
  reasons: [{ text: 'You added it to the queue.' }], characteristics: {}, playback: { kind: 'none' },
} as unknown as RecItem);

const draw = (seeds: Track[], items: RecItem[], extra: Record<string, unknown> = {}) =>
  render(
    <Results
      seeds={seeds} onRemoveSeed={() => {}} onEmphasis={() => {}} items={items}
      focusKey={null} playingKey={null} flags={{}} onFocus={() => {}} onPlay={() => {}}
      onPlayTrack={() => {}} onFeedback={() => {}} {...extra}
    />,
  );

// Each case draws its own list; without this they stack up in one document.
afterEach(cleanup);

const rowsFor = (title: string) =>
  screen.getAllByRole('listitem').filter((li) => within(li).queryAllByText(title).length > 0);

describe('one song, one row (SEED-DUPE-001)', () => {
  it('draws the added song once, not as a seed row and a queue row', () => {
    const t = track();
    draw([t], [item(t)]);
    expect(rowsFor('tell me what you want')).toHaveLength(1);
  });

  it('keeps the queue row, with its rank and reason', () => {
    const t = track();
    draw([t], [item(t)]);
    const [row] = rowsFor('tell me what you want');
    expect(row!.className).not.toContain('rec--seed');
    expect(within(row!).getByText('You added it to the queue.')).toBeTruthy();
  });

  it('says on that row that it is a starting song', () => {
    const t = track();
    draw([t], [item(t)]);
    const [row] = rowsFor('tell me what you want');
    expect(within(row!).getByText(/Starting song/)).toBeTruthy();
  });

  it('can still stop a queued song being a starting song', async () => {
    const t = track();
    const onRemoveSeed = vi.fn();
    render(
      <Results
        seeds={[t]} onRemoveSeed={onRemoveSeed} onEmphasis={() => {}} items={[item(t)]}
        focusKey={null} playingKey={null} flags={{}} onFocus={() => {}} onPlay={() => {}}
        onPlayTrack={() => {}} onFeedback={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Stop .* being a starting song|Remove tell me what you want as a starting song/i }));
    expect(onRemoveSeed).toHaveBeenCalledWith('k1');
  });

  it('treats the same recording from another service as the same song', () => {
    const seed = track({ key: 'yt-key', provider: 'ytmusic', isrc: 'GBXXX1234567' });
    const queued = track({ key: 'dz-key', id: 'dz:9', provider: 'deezer', platform_id: '9', isrc: 'GBXXX1234567' });
    draw([seed], [item(queued)]);
    expect(rowsFor('tell me what you want')).toHaveLength(1);
  });

  it('still shows a starting song that is not in the queue', () => {
    const seed = track({ key: 'seed-only', title: 'Only a seed' });
    draw([seed], [item(track({ key: 'other', title: 'Something else' }))]);
    expect(rowsFor('Only a seed')).toHaveLength(1);
    expect(rowsFor('Only a seed')[0]!.className).toContain('rec--seed');
  });
});
