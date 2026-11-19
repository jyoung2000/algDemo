// ARTIST-CIRCLE-001 (owner, 2026-11-19): "on the artist profile add a section for frequent collaborators so users can
// see other artist a person frequently collaborates with and a similar artist section that finds similar artist based
// on platform data".
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collaboratorsOf, mergeSimilar, COLLAB_MIN_SONGS } from './artist-circle';
import { parseYtArtistPage, type ArtistSummary } from './artists';

const here = dirname(fileURLToPath(import.meta.url));
const t = (title: string, artists: string[]) => ({ key: `k:${title}`, title, artists, artist: artists[0]! });

describe('frequent collaborators', () => {
  const songs = [
    t('One', ['Ken Carson', 'Destroy Lonely']),
    t('Two', ['Destroy Lonely', 'Ken Carson']),
    t('Three', ['Ken Carson', 'Destroy Lonely', 'Playboi Carti']),
    t('Four', ['Playboi Carti', 'Ken Carson']),
    t('Five', ['Ken Carson', 'Lil Uzi Vert']),
    t('Six', ['ken carson']),
    t('Two (Remix)', ['Destroy Lonely', 'Ken Carson']),
    t('Seven', ['Various Artists', 'Ken Carson']),
  ];
  it('counts different songs each artist shares with them, most first, never the artist themself', () => {
    const c = collaboratorsOf('Ken Carson', songs);
    expect(c.map((x) => [x.name, x.songs])).toEqual([
      ['Destroy Lonely', 3],
      ['Playboi Carti', 2],
    ]);
    expect(c[0]!.titles).toEqual(['One', 'Two', 'Three']);
  });
  it('a one-off guest is not "frequent", unless asked for', () => {
    expect(COLLAB_MIN_SONGS).toBe(2);
    expect(collaboratorsOf('Ken Carson', songs).some((x) => x.name === 'Lil Uzi Vert')).toBe(false);
    expect(collaboratorsOf('Ken Carson', songs, { min: 1 }).some((x) => x.name === 'Lil Uzi Vert')).toBe(true);
  });
  it('the same song from two services counts once', () => {
    const dup = [t('Fate', ['A', 'B']), { ...t('Fate (feat. B)', ['A', 'B']), key: 'yt:1' }, t('Other', ['A', 'B'])];
    expect(collaboratorsOf('A', dup)[0]!.songs).toBe(2);
  });
});

describe('similar artists from the platforms', () => {
  const dz = (name: string, fans: number): ArtistSummary => ({ id: `dz:${name}`, provider: 'deezer', name, picture: null, detail: null, fans, url: '' });
  const yt = (name: string): ArtistSummary => ({ id: `yt:${name}`, provider: 'ytmusic', name, picture: 'p.jpg', detail: '1M monthly audience', url: '' });
  it('takes turns between services, one row per artist, never the artist themself', () => {
    const m = mergeSimilar('Ken Carson', [dz('Destroy Lonely', 10), dz('Yeat', 5), dz('Ken Carson', 1)], [yt('Yeat'), yt('Homixide Gang')]);
    expect(m.map((a) => a.name)).toEqual(['Destroy Lonely', 'Yeat', 'Homixide Gang']);
    // Yeat came from both: kept once, with the picture the Deezer row lacked
    expect(m[1]!.picture).toBe('p.jpg');
    expect([...m[1]!.from].sort()).toEqual(['deezer', 'ytmusic']);
  });
  it('YouTube Music\u2019s "Fans might also like" shelf is read from the artist page', () => {
    const page = parseYtArtistPage(JSON.parse(readFileSync(join(here, 'golden', 'ytm-artist.json'), 'utf8')));
    expect(page.related.map((a) => a.name)).toEqual(['Yeat']);
    expect(page.related[0]!.id).toBe('yt:UCXvxWMFHlTAXlhpwkQ4Y2Hw');
    expect(page.related[0]!.detail).toBe('37M monthly audience');
  });
});
