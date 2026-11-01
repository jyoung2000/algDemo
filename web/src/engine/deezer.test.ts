import { describe, expect, it } from 'vitest';
import { Deezer, ProviderError } from './deezer';
import { Http, HostPacer, type HttpPort, type HttpRequest, type HttpResponse } from './net';
import { previewExpiry, release } from './track';

const enc = (s: string) => new TextEncoder().encode(s);
const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: enc(JSON.stringify(body)) });

/** Routes each request URL to a recorded body; records every URL asked for. */
function recorded(routes: Record<string, unknown>) {
  const seen: string[] = [];
  const port: HttpPort = {
    async request(req: HttpRequest) {
      seen.push(req.url);
      const path = new URL(req.url).pathname + new URL(req.url).search;
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      if (!key) return { status: 404, headers: {}, body: enc('{}') };
      return ok(routes[key]);
    },
  };
  const dz = new Deezer(new Http(port, new HostPacer({}, 0)));
  return { dz, seen };
}

// Recorded shape of a Deezer /track/{id} answer (fields the adapter reads).
const TRACK = {
  id: 3135556,
  title: 'Harder, Better, Faster, Stronger',
  title_short: 'Harder, Better, Faster, Stronger',
  title_version: '',
  link: 'https://www.deezer.com/track/3135556',
  duration: 224,
  isrc: 'GBDUE0100009',
  release_date: '2001-03-07',
  explicit_lyrics: false,
  bpm: 123.4,
  rank: 912345,
  preview: 'https://cdns-preview-d.dzcdn.net/stream/c-x.mp3?hdnea=exp=1793000900~acl=/x~hmac=abc',
  artist: { id: 27, name: 'Daft Punk' },
  contributors: [{ name: 'Daft Punk' }, { name: 'Bangalter' }],
  album: {
    id: 302127,
    title: 'Discovery',
    cover_medium: 'https://cdn/cover.jpg',
    release_date: '2001-03-12',
    genres: { data: [{ name: 'Dance' }, { name: '' }] },
  },
};

describe('Deezer adapter', () => {
  it('maps a track like providers.py Deezer.to_track', async () => {
    const { dz } = recorded({ '/track/3135556': TRACK });
    const t = await dz.track('3135556');
    expect(t.id).toBe('deezer:3135556');
    expect(t.platform_id).toBe('3135556');
    expect(t.artists).toEqual(['Daft Punk', 'Bangalter']); // contributors win over artist.name
    expect(t.artist).toBe('Daft Punk, Bangalter');
    expect(t.album).toBe('Discovery');
    expect(t.duration).toBe(224);
    expect(t.isrc).toBe('GBDUE0100009');
    expect(t.bpm).toBe(123.4);
    expect(t.explicit).toBe(false);
    expect(t.artist_ids).toEqual({ deezer: '27' });
    expect(t.album_id).toBe('302127');
    expect(t.popularity).toBe(912345);
    expect(t.release).toEqual({ date: '2001-03-07', precision: 'day', kind: 'release', source: 'Deezer' });
    // the empty-named genre is dropped, as `[x for x in tags if x]` does in Python
    expect(t.tags.map((g) => g.name)).toEqual(['dance']);
    expect(t.kind).toBe('song');
  });

  it('falls back to the album date and the artist name when contributors are missing', async () => {
    const { dz } = recorded({ '/track/1': { ...TRACK, id: 1, release_date: undefined, contributors: [], album: { ...TRACK.album, release_date: '2001' } } });
    const t = await dz.track('1');
    expect(t.artists).toEqual(['Daft Punk']);
    expect(t.release).toEqual({ date: '2001', precision: 'year', kind: 'release', source: 'Deezer' });
  });

  it('search keeps only readable tracks and forwards the query encoded', async () => {
    const { dz, seen } = recorded({
      '/search': { data: [{ ...TRACK, id: 1, readable: true }, { ...TRACK, id: 2, readable: false }, { ...TRACK, id: 3, type: 'album' }] },
    });
    const hits = await dz.search('daft punk & jazz', 5);
    expect(hits.map((h) => h.platform_id)).toEqual(['1']);
    expect(seen[0]).toContain('/search?q=daft%20punk%20%26%20jazz&limit=5');
  });

  it('turns a Deezer error object into a ProviderError', async () => {
    const { dz } = recorded({ '/search': { error: { type: 'QuotaException', message: 'too many requests' } } });
    await expect(dz.search('x')).rejects.toThrow(ProviderError);
  });

  it('refuses a non-track share link and reports which kind it was', async () => {
    const { dz } = recorded({});
    await expect(dz.resolveLink('https://www.deezer.com/album/99')).rejects.toThrow('That is a Deezer album');
    await expect(dz.resolveLink('https://www.deezer.com/')).rejects.toThrow('not a track link');
  });

  it('resolves a track link to its track record', async () => {
    const { dz } = recorded({ '/track/3135556': TRACK });
    const t = await dz.resolveLink('https://www.deezer.com/en/track/3135556?utm=x');
    expect(t.platform_id).toBe('3135556');
  });

  it('refuses a share link on a host outside the allowlist', async () => {
    const { dz } = recorded({});
    await expect(dz.resolveLink('https://evil.example/track/1')).rejects.toThrow();
  });

  it('keeps a still-valid preview and re-reads the track when it is near expiry', async () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    const stillValid = `https://cdns-preview-d.dzcdn.net/x.mp3?exp=${future}~hmac=1`;
    const { dz, seen } = recorded({ '/track/9': { ...TRACK, id: 9, preview: 'https://cdns-preview-d.dzcdn.net/new.mp3?exp=9999999999' } });
    expect(await dz.freshPreview('9', stillValid)).toBe(stillValid);
    expect(seen).toEqual([]); // no network when the signature is fine
    const stale = `https://cdns-preview-d.dzcdn.net/x.mp3?exp=${future - 1000}~hmac=1`;
    expect(await dz.freshPreview('9', stale)).toBe('https://cdns-preview-d.dzcdn.net/new.mp3?exp=9999999999');
    expect(seen.length).toBe(1);
  });

  it('reads the signature expiry like preview_expiry (0 when unsigned)', () => {
    expect(previewExpiry('https://x/y.mp3?hdnea=exp=1793000900~acl=/z')).toBe(1793000900);
    expect(previewExpiry('https://x/y.mp3')).toBe(0);
    expect(previewExpiry('')).toBe(0);
  });

  it('release() matches providers.py precision rules', () => {
    expect(release('20010307', 'release', 'Deezer')?.date).toBe('2001-03-07');
    expect(release('2001-03', 'release', 'Deezer')?.precision).toBe('month');
    expect(release('0000-00-00', 'release', 'Deezer')).toBeNull();
    expect(release('not a date', 'release', 'Deezer')).toBeNull();
    expect(release(null, 'release', 'Deezer')).toBeNull();
  });

  it('genreIds keeps the first id per canonical genre and drops unknown names', async () => {
    const { dz } = recorded({ '/genre': { data: [{ id: 132, name: 'Pop' }, { id: 7, name: 'pop' }, { id: 1, name: 'Zzz unknown' }] } });
    const ids = await dz.genreIds();
    expect(ids['pop']).toBe(132);
    expect(Object.keys(ids).some((k) => k.includes('unknown'))).toBe(false);
  });
});
