import { expect, it, vi } from 'vitest';
import type { Track } from '../api';

const state = vi.hoisted(() => ({
  fullSong: vi.fn(),
  backend: null as unknown as { resolve: (t: Track, retry: boolean, exclude: string[]) => Promise<string | null> },
}));
vi.mock('../api', () => ({ api: { fullSong: state.fullSong } }));
vi.mock('./queue-preload', () => ({ QueuePreloader: class {
  constructor(backend: typeof state.backend) { state.backend = backend; }
} }));
import './queue-audio';

it('does not reintroduce the rejected URL through the track-link fallback', async () => {
  const url = 'https://music.youtube.com/watch?v=qapK8Gx6ZTo';
  const t = { key: 'dead-link', provider: 'ytmusic', platform_id: 'qapK8Gx6ZTo', title: 'Song', artists: ['Artist'], url } as Track;
  state.fullSong.mockResolvedValue({ id: null, source: 'none' });
  expect(await state.backend.resolve(t, true, [url])).toBeNull();
  expect(state.fullSong).toHaveBeenLastCalledWith(t, true, [url]);
});

it('still downloads a usable track link when the search has no match', async () => {
  const url = 'https://soundcloud.com/artist/song';
  state.fullSong.mockResolvedValue({ id: null, source: 'none' });
  const t = { key: 'usable-link', provider: 'soundcloud', title: 'Song', artists: ['Artist'], url } as Track;
  expect(await state.backend.resolve(t, true, [])).toBe(url);
});
