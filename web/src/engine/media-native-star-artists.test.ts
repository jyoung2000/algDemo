// @vitest-environment happy-dom
// ARTIST-FAV-CAR-001 (owner, 2026-11-22): "add a player control button to android auto to star the artist of current
// playing track and add the artist / artist on the current track to your prefered artist".
import { describe, expect, it, vi } from 'vitest';
import { artistNamesOf, setMediaHandlers } from './media-native';

describe('the car\u2019s Star the artist command', () => {
  it('names the song\u2019s own artists, else reads the credit line', () => {
    expect(artistNamesOf({ artists: ['Lil Tecca', 'Ken Carson'] }, 'ignored')).toEqual(['Lil Tecca', 'Ken Carson']);
    expect(artistNamesOf(null, 'NLE Choppa feat. Dee Play4Keeps')).toEqual(['NLE Choppa', 'Dee Play4Keeps']);
    expect(artistNamesOf(undefined, 'Simon & Garfunkel, simon & garfunkel')).toEqual(['Simon & Garfunkel']);
  });
  it('reaches the handler with the song id, its credit and its Track', async () => {
    const starArtists = vi.fn();
    setMediaHandlers({ starArtists });
    const hook = (window as unknown as { __awMediaCmd?: (json: string) => void }).__awMediaCmd;
    expect(hook).toBeTypeOf('function');
    hook!(JSON.stringify({ type: 'starArtists', id: 'deezer:1', artist: 'OsamaSon', track: { key: 'deezer:1', provider: 'deezer', platform_id: '1', title: 'x', artists: ['OsamaSon'] } }));
    await Promise.resolve();
    expect(starArtists).toHaveBeenCalledTimes(1);
    expect(starArtists.mock.calls[0]![0]).toBe('deezer:1');
    expect(starArtists.mock.calls[0]![1]).toBe('OsamaSon');
  });
});
