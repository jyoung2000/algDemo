// @vitest-environment happy-dom
// RADIO-ART-002: matching a broadcaster's song text to a catalogue record, and borrowing cover art
// from another platform's result for the SAME song when the best match carries none. Station tags
// are never song evidence, and a force pass only re-asks while a cover is still missing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../api';
import type { Broadcast } from './radio';
const f = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('../api', () => ({ api: { search: (...a: unknown[]) => f.search(...a) } }));
vi.mock('../audio-engine', () => ({ radioOutput: () => null }));
const { matchSongBroadcast } = await import('./radio-client');

const sb = (title: string, artist: string): Broadcast => ({ kind: 'song', state: 'current', title, artist, source: 'Broadcaster ICY', checkedAt: Date.now() } as Broadcast);
const track = (o: Partial<Track>): Track => ({ id: 'x', provider: 'deezer', platform_id: '1', key: 'x', title: '', ...o } as Track);
beforeEach(() => { f.search.mockReset(); });

describe('cross-platform artwork for a matched radio song (RADIO-ART-002)', () => {
  it('borrows cover art from another platform result for the same song when the best match has none', async () => {
    f.search.mockResolvedValue({ results: [
      track({ key: 'yt', provider: 'ytmusic', title: 'Night Drive', artist: 'Mara' }), // right song, no cover
      track({ key: 'wrong', provider: 'deezer', title: 'Different Song', artist: 'Mara', artwork: 'https://cdn.example/wrong.jpg' }),
      track({ key: 'dz', provider: 'deezer', title: 'Night Drive', artists: ['Mara'], artwork: 'https://cdn.example/night.jpg' }),
    ] });
    const t = await matchSongBroadcast(sb('Night Drive', 'Mara'));
    expect(t?.key).toBe('yt'); // identity stays with the best match
    expect(t?.artwork).toBe('https://cdn.example/night.jpg'); // the cover comes from the same song on Deezer, never an unrelated row
  });
  it('re-asks a cached miss only under force, and never re-fetches a cover already resolved', async () => {
    f.search.mockResolvedValue({ results: [] });
    expect(await matchSongBroadcast(sb('Glass Houses', 'Rhea'))).toBeNull();
    expect(await matchSongBroadcast(sb('Glass Houses', 'Rhea'))).toBeNull();
    expect(f.search).toHaveBeenCalledTimes(1); // the negative answer is cached for passive refreshes
    f.search.mockResolvedValue({ results: [track({ key: 'dz', title: 'Glass Houses', artist: 'Rhea', artwork: 'https://cdn.example/glass.jpg' })] });
    const t = await matchSongBroadcast(sb('Glass Houses', 'Rhea'), { force: true });
    expect(t?.artwork).toBe('https://cdn.example/glass.jpg'); // a manual refresh resolves the missing cover
    expect(f.search).toHaveBeenCalledTimes(2);
    await matchSongBroadcast(sb('Glass Houses', 'Rhea'), { force: true });
    expect(f.search).toHaveBeenCalledTimes(2); // force is bounded: a resolved cover is reused
  });
  it('matches "JACKSON 5, THE" to the catalogue "Jackson 5" and searches with the cleaned name (RADIO-ARTIST-001)', async () => {
    f.search.mockResolvedValue({ results: [
      track({ key: 'karaoke', title: 'ABC', artist: 'Karaoke - The Jackson 5' }),
      track({ key: 'dz', title: 'ABC', artists: ['Jackson 5'], artist_ids: { deezer: '75332' } } as Partial<Track>),
    ] });
    const t = await matchSongBroadcast(sb('ABC', 'JACKSON 5, THE'));
    expect(t?.key).toBe('dz');
    expect(f.search).toHaveBeenCalledWith('The Jackson 5 ABC');
  });
  it('never treats a programme or tag-only metadata as a song to match', async () => {
    expect(await matchSongBroadcast({ kind: 'programme', state: 'current', title: 'Morning Show', artist: null, source: 'Broadcaster', checkedAt: Date.now() } as unknown as Broadcast)).toBeNull();
    expect(f.search).not.toHaveBeenCalled();
  });
});
