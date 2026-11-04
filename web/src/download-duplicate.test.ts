import { expect, it, vi } from 'vitest';
import { heldCopy, type HeldLookup } from './engine/held';

const lookup = (r: Partial<Awaited<ReturnType<HeldLookup>>>): HeldLookup =>
  vi.fn(async () => ({ file: null, kept: false, cached: false, running: false, error: null, ...r }));

it('reports a song already kept in the Music folder, whichever tool fetched it', async () => {
  // The duplicate bug: a spotdl song was never registered, so a second Download wrote
  // "Artist - Title (2).opus". The shell now records it, and the UI must ask before refetching —
  // for every tool and format, not just yt-dlp/original.
  const spotify = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';
  const held = await heldCopy(lookup({ kept: true, file: { name: 'Song.mp3', bytes: 20 } }), spotify);
  expect(held).toMatchObject({ kept: true, file: { name: 'Song.mp3' } });
});

it('does not claim a cache-only entry is a kept copy', async () => {
  // A queue-cache entry is evictable. Reporting it as "already downloaded" would tell the listener
  // they have a permanent copy they do not have.
  const held = await heldCopy(lookup({ cached: true, file: { name: 'x.opus', bytes: 20 } }), 'https://music.youtube.com/watch?v=abcdefghijk');
  expect(held).toBeNull();
});

it('returns nothing while a download for the link is still running', async () => {
  const held = await heldCopy(lookup({ kept: true, running: true, file: { name: 'x.opus', bytes: 20 } }), 'https://music.youtube.com/watch?v=abcdefghijk');
  expect(held).toBeNull();
});

it('treats a shell that cannot answer as "not held" rather than blocking the download', async () => {
  // An older shell has no `kept` field and a browser has no shell at all. Refusing to download
  // because the question failed would be worse than one extra file.
  const legacy: HeldLookup = vi.fn(async () => ({ file: { name: 'x.opus', bytes: 20 }, running: false, error: null }));
  expect(await heldCopy(legacy, 'https://music.youtube.com/watch?v=abcdefghijk')).toBeNull();
  const broken: HeldLookup = vi.fn(async () => { throw new Error('no shell'); });
  expect(await heldCopy(broken, 'https://music.youtube.com/watch?v=abcdefghijk')).toBeNull();
});

it('asks the shell exactly once per check', async () => {
  const spy = lookup({ kept: true, file: { name: 'x.mp3', bytes: 20 } });
  await heldCopy(spy, 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
  expect(spy).toHaveBeenCalledTimes(1);
});
