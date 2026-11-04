/**
 * NP-ALWAYS-001 — a song always has somewhere to play, and the bar is always there.
 *
 * From the owner's screenshot: "BATMAN" by rexv2 showed "No player here for this song. Open it in
 * its app.", no progress bar, a dead play button. The song was carrying a YouTube Music link the
 * whole time, and both shells carry yt-dlp.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { downloadableTrack, rescueSource } from './rescue';

describe('which link can rescue a song (NP-ALWAYS-001)', () => {
  it('takes the id YouTube refused to embed, because it names this exact recording', () => {
    expect(rescueSource({ badVideoId: 'dQw4w9WgXcQ', shell: true })).toBe('https://music.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('falls back to the song’s own links when no video was found at all', () => {
    expect(
      rescueSource({
        links: [{ url: 'https://open.spotify.com/track/abc' }, { url: 'https://music.youtube.com/watch?v=aaaaaaaaaaa' }],
        shell: true,
      }),
    ).toBe('https://music.youtube.com/watch?v=aaaaaaaaaaa');
  });

  it('prefers the refused id over a provider link, which may be another master', () => {
    expect(rescueSource({ badVideoId: 'dQw4w9WgXcQ', links: [{ url: 'https://soundcloud.com/rexv2/batman' }], shell: true })).toBe(
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    );
  });

  it('downloads nothing in a plain browser, where there is no shell to ask', () => {
    expect(rescueSource({ badVideoId: 'dQw4w9WgXcQ', links: [{ url: 'https://soundcloud.com/a/b' }], shell: false })).toBeNull();
  });

  it('gives up honestly when every link is one yt-dlp cannot fetch', () => {
    expect(rescueSource({ links: [{ url: 'https://open.spotify.com/track/abc' }, { url: 'https://deezer.com/track/1' }], shell: true })).toBeNull();
  });
});

describe('links yt-dlp can turn into one song (NP-ALWAYS-001)', () => {
  it('accepts a watch link, a youtu.be link, shorts and a soundcloud track', () => {
    expect(downloadableTrack('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(downloadableTrack('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RD')).toBe(true);
    expect(downloadableTrack('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(downloadableTrack('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(true);
    expect(downloadableTrack('https://soundcloud.com/rexv2/batman')).toBe(true);
  });

  it('refuses pages that name no single song, so a download cannot fail for nothing', () => {
    // A search page is the tempting one: right host, no video.
    expect(downloadableTrack('https://music.youtube.com/search?q=batman%20rexv2')).toBe(false);
    expect(downloadableTrack('https://www.youtube.com/watch?v=short')).toBe(false);
    expect(downloadableTrack('https://soundcloud.com/rexv2')).toBe(false);
    expect(downloadableTrack('https://soundcloud.com/search?q=batman')).toBe(false);
    expect(downloadableTrack('https://www.youtube.com/channel/UC123')).toBe(false);
  });

  it('refuses hosts the shells will not hand to yt-dlp, and anything unparseable', () => {
    expect(downloadableTrack('https://open.spotify.com/track/abc')).toBe(false);
    expect(downloadableTrack('https://www.deezer.com/track/1')).toBe(false);
    expect(downloadableTrack('not a url')).toBe(false);
    expect(downloadableTrack('javascript:alert(1)')).toBe(false);
  });
});

describe('the search list never hides Play (NP-ALWAYS-001)', () => {
  it('offers Play on every row, whatever the song carries', () => {
    const search = readFileSync(new URL('../Search.tsx', import.meta.url), 'utf8');
    // The owner's BATMAN row had Download and Like and no Play, because the row judged the song
    // playable by its preview and provider instead of letting the player try.
    expect(search).not.toMatch(/t\.preview \|\| t\.provider === 'ytmusic'/);
    expect(search).toMatch(/aria-label=\{`Play \$\{t\.title\}`\}/);
  });
});

describe('the player never strands a song (NP-ALWAYS-001)', () => {
  const player = readFileSync(new URL('../Player.tsx', import.meta.url), 'utf8');

  it('tries a download whenever nothing else can play the song', () => {
    expect(player).toMatch(/import \{ rescueSource \} from '\.\/engine\/rescue'/);
    // Stranded = no full song, no preview, no embed, and the lookup has finished.
    expect(player).toMatch(/const stranded =/);
    expect(player).toMatch(/const rescue = stranded\s*\?\s*rescueSource\(\{/);
  });

  it('keeps the progress bar on screen for every song, playable or not', () => {
    expect(player).toMatch(/const progress = playing \? \(/);
    expect(player).not.toMatch(/const progress = hasSound \|\| pending \?/);
  });

  it('says it is fetching the song while the download runs, not that there is no player', () => {
    expect(player).toMatch(/fetchingLocal/);
    expect(player).toMatch(/Downloading the full song to the player/);
  });

  it('only admits defeat when there is no link left to try', () => {
    expect(player).toMatch(/No player here for this song/);
    expect(player).toMatch(/rescue === null/);
  });
});
