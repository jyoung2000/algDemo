import { describe, expect, it } from 'vitest';
import { canMatch, confidentMatch, enrichImported, fileGenreTags, uniqueTags } from './imported-genres';
import { makeTag, type Tag } from './genres';
import { genreIdentity } from './genre-identity';
import type { Dict } from './shape';

/**
 * IMPORT-GENRES-001: imported songs get catalogue genres only from a confident title-plus-artist
 * match, and the tags they get follow TAGS-CANON-001 (one canonical tag per genre however spelt).
 */
const cand = (title: string, artist: string, over: Record<string, unknown> = {}) => ({ title, artists: [artist], duration: 200, platform_id: `${artist}-${title}`, ...over });
const song = (title: string, artist: string | null, over: Record<string, unknown> = {}): Dict => ({ title, artists: artist ? [artist] : [], provider: 'imported', url: `imported:C:\\Music\\${artist} - ${title}.opus`, tags: [] as Tag[], ...over });
const tag = (name: string, label = name) => makeTag(name, 'Deezer album genre', 'album', 0.8)!;

describe('confident title-plus-artist matching', () => {
  it('matches the same title by the same artist, and says the match is unproven without a length', () => {
    const hit = confidentMatch(song('One More Time', 'Daft Punk'), [cand('Around the World', 'Daft Punk'), cand('One More Time', 'Daft Punk')]);
    expect(hit?.match.platform_id).toBe('Daft Punk-One More Time');
    expect(hit?.proven).toBe(false);
  });

  it('proves a match when the lengths agree, and refuses one when they contradict', () => {
    expect(confidentMatch(song('One More Time', 'Daft Punk', { duration: 201 }), [cand('One More Time', 'Daft Punk')])?.proven).toBe(true);
    expect(confidentMatch(song('One More Time', 'Daft Punk', { duration: 320 }), [cand('One More Time', 'Daft Punk')])).toBeNull();
  });

  it('ignores case, accents and featured artists, but never another artist or another version', () => {
    expect(confidentMatch(song('beyonce halo', 'BEYONCÉ'), [cand('Beyoncé Halo', 'Beyonce')])).not.toBeNull();
    expect(confidentMatch(song('Sicko Mode (feat. Drake)', 'Travis Scott'), [cand('SICKO MODE', 'Travis Scott')])).not.toBeNull();
    expect(confidentMatch(song('Halo', 'Beyoncé'), [cand('Halo', 'Haloo Helsinki!')])).toBeNull();
    expect(confidentMatch(song('Halo', 'Beyoncé'), [cand('Halo (Live)', 'Beyoncé')])).toBeNull();
    expect(confidentMatch(song('Halo (Slowed)', 'Beyoncé'), [cand('Halo', 'Beyoncé')])).toBeNull();
  });

  it('does not accept a title that only differs slightly', () => {
    expect(confidentMatch(song('Love Story', 'Taylor Swift'), [cand("Love Story (Taylor's Version) Remix", 'Taylor Swift')])).toBeNull();
    expect(confidentMatch(song('Love', 'Taylor Swift'), [cand('Love Story', 'Taylor Swift')])).toBeNull();
  });

  it('never looks up a song with no artist (a file name without "Artist - Title")', () => {
    expect(canMatch(song('track01', null))).toBe(false);
    expect(confidentMatch(song('Africa', null), [cand('Africa', 'Toto')])).toBeNull();
  });

  it('leaves test files named "Test Artist - Imported Song N" unmatched against real catalogue songs', () => {
    expect(confidentMatch(song('Imported Song 1', 'Test Artist'), [cand('Imported', 'Test Dept'), cand('Song 1', 'Artist')])).toBeNull();
  });
});

describe('canonical tags (TAGS-CANON-001)', () => {
  it('reads a file genre field into one canonical tag per genre', () => {
    expect(fileGenreTags('Hip-Hop/Rap').map((t) => t.name)).toEqual(['hip-hop']);
    expect(fileGenreTags('Rap; Hip Hop').map((t) => t.name)).toEqual(['hip-hop']);
    expect(fileGenreTags('rnb').map((t) => t.name)).toEqual(['r&b']);
    expect(fileGenreTags('R&B; r and b; RnB').map((t) => t.name)).toEqual(['r&b']);
    expect(fileGenreTags('Rap; Rage').map((t) => t.name)).toEqual(['hip-hop', 'rage']);
    expect(fileGenreTags('free download; meh')).toEqual([]);
    expect(fileGenreTags(undefined)).toEqual([]);
  });

  it('a song carries Rap and Hip Hop as one tag, and the bubble is capitalised with no slash', () => {
    const tags = uniqueTags([tag('Rap'), tag('Hip Hop'), tag('Rage')]);
    expect(tags.map((t) => t.name)).toEqual(['hip-hop', 'rage']);
    for (const t of tags) {
      const id = genreIdentity(t.label)!;
      expect(id.label).not.toMatch(/\//);
      expect(id.label[0]).toBe(id.label[0]!.toUpperCase());
    }
    expect(genreIdentity('rnb')?.label).toBe('R&B');
    expect(genreIdentity('r&b')?.key).toBe(genreIdentity('RnB')?.key);
  });
});

describe('what a confident match lends an imported song', () => {
  it('attaches the catalogue genres, cover and length, and keeps the file as the playback source', () => {
    const s = song('Sicko Mode', 'Travis Scott');
    const out = enrichImported(s, { tags: [tag('Rap'), tag('Hip Hop')], artwork: 'https://cdn-images.dzcdn.net/cover.jpg', duration: 312.4 });
    expect((out.tags as Tag[]).map((t) => t.name)).toEqual(['hip-hop']);
    expect(out['artwork']).toBe('https://cdn-images.dzcdn.net/cover.jpg');
    expect(out['duration']).toBe(312);
    expect(out.url).toBe(s.url);
    expect(out.provider).toBe('imported');
  });

  it('uses the file genre only when the catalogue names none, and never overwrites what the song has', () => {
    expect((enrichImported(song('X', 'Y'), { tags: [] }, 'rnb').tags as Tag[]).map((t) => t.name)).toEqual(['r&b']);
    const own = song('X', 'Y', { tags: [tag('Jazz')], artwork: 'https://a/own.jpg', duration: 100 });
    const out = enrichImported(own, { tags: [tag('Pop')], artwork: 'https://b/other.jpg', duration: 200 });
    expect((out.tags as Tag[]).map((t) => t.name)).toEqual(['jazz']);
    expect(out['artwork']).toBe('https://a/own.jpg');
    expect(out['duration']).toBe(100);
  });

  it('ignores a non-https cover', () => {
    expect(enrichImported(song('X', 'Y'), { tags: [], artwork: 'http://insecure/c.jpg' })['artwork']).toBeUndefined();
  });
});
