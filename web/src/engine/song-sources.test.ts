// @vitest-environment happy-dom
// ROW-DL-KEPT-001 (owner, 2026-11-22): "the download button should only be removed when the download button is
// explictly pressed and the user permanaently saved and downloaded the song". Measured on the phone build: a song saved
// that way lost its blue Play button and got its Download icon back after the app was reopened, because a song found
// through another service has no link of its own and the one it was saved under was only remembered until the app
// closed. The link a Download press used is kept on the device; whether the file is still there is the shell's answer.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVED_LINKS_KEY, SAVED_LINKS_MAX } from './song-sources';

const fresh = async () => { vi.resetModules(); return (await import('./song-sources')).songSources; };
beforeEach(() => { window.localStorage.clear(); });

describe('the link a song was saved under outlives the app closing', () => {
  it('is there again when the app is opened afresh', async () => {
    const a = await fresh();
    a.keep('deezer:1', 'https://music.youtube.com/watch?v=saved000001');
    expect(a.get('deezer:1')).toBe('https://music.youtube.com/watch?v=saved000001');
    const b = await fresh();
    expect(b.get('deezer:1')).toBe('https://music.youtube.com/watch?v=saved000001');
  });

  it('is not forgotten however many other songs are played afterwards', async () => {
    const a = await fresh();
    a.keep('deezer:1', 'https://music.youtube.com/watch?v=saved000001');
    for (let i = 0; i < 1000; i++) a.set(`deezer:p${i}`, `https://music.youtube.com/watch?v=p${i}`);
    expect(a.get('deezer:1')).toBe('https://music.youtube.com/watch?v=saved000001');
  });

  it('a link only played from is not written to the device', async () => {
    const a = await fresh();
    a.set('deezer:2', 'https://music.youtube.com/watch?v=played00001');
    expect(window.localStorage.getItem(SAVED_LINKS_KEY)).toBeNull();
    expect((await fresh()).get('deezer:2')).toBeNull();
  });

  it('tells its listeners, keeps the newest when full, and survives a damaged record', async () => {
    const a = await fresh();
    const heard = vi.fn();
    a.subscribe(heard);
    a.keep('deezer:1', 'https://music.youtube.com/watch?v=saved000001');
    expect(heard).toHaveBeenCalledTimes(1);
    a.keep('deezer:1', 'https://music.youtube.com/watch?v=saved000001');
    expect(heard).toHaveBeenCalledTimes(1);
    for (let i = 0; i < SAVED_LINKS_MAX; i++) a.keep(`deezer:k${i}`, `https://music.youtube.com/watch?v=k${i}`);
    const b = await fresh();
    expect(b.get('deezer:1')).toBeNull();
    expect(b.get(`deezer:k${SAVED_LINKS_MAX - 1}`)).toBe(`https://music.youtube.com/watch?v=k${SAVED_LINKS_MAX - 1}`);
    window.localStorage.setItem(SAVED_LINKS_KEY, '{not json');
    expect((await fresh()).get('deezer:k5')).toBeNull();
    window.localStorage.setItem(SAVED_LINKS_KEY, JSON.stringify([['deezer:9', 7], 'x', ['deezer:8', 'https://music.youtube.com/watch?v=ok']]));
    const c = await fresh();
    expect(c.get('deezer:9')).toBeNull();
    expect(c.get('deezer:8')).toBe('https://music.youtube.com/watch?v=ok');
  });
});
