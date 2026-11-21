// RADIO-PLAYING-NOW-001 (owner, 2026-11-20): "You should also be able to search by artist name or song name the
// radio tab to find any station playing that artist or song currently".
//
// TuneIn's station search (opml.radiotime.com/Search.ashx) reports the song each station is playing as it answers;
// Radio Browser and iHeart's directory do not. A station is listed only when that CURRENT song names what was typed:
// a station called "Drake Radio" or tagged hip hop is not playing Drake now. Each match is checked once more against
// the station's own details (Describe.ashx), which also give its place and language. Station facts never train taste.
import { fold } from './identity';
import { publicUrl, type Broadcast, type RadioStation } from './radio';

const OPML = 'https://opml.radiotime.com';
const GUIDE = /^s\d{1,9}$/;
export interface PlayingStation { station: RadioStation; broadcast: Broadcast }
type GetText = (url: string) => Promise<string>;
const txt = (v: unknown) => String(v ?? '').trim().slice(0, 500);

export const tuneinSearchUrl = (q: string) => `${OPML}/Search.ashx?${new URLSearchParams({ query: q.trim().slice(0, 80), types: 'station', render: 'json' })}`;
export const tuneinTuneUrl = (guide: string) => `${OPML}/Tune.ashx?id=${guide}`;
export const tuneinDescribeUrl = (guide: string) => `${OPML}/Describe.ashx?id=${guide}&render=json`;
export const tuneinNowUrl = (guide: string) => `https://feed.tunein.com/profiles/${guide}/nowPlaying`;
/** The TuneIn guide id behind one of our station ids ("ti-s28032"), or null for any other directory's station. */
export function tuneinGuide(id: string): string | null { const m = /^ti-(s\d{1,9})$/.exec(id); return m ? m[1]! : null; }

/** "Artist - Title" as TuneIn writes it. Only the first " - " splits, so "Jay-Z - Song" keeps its name. */
function song(text: string): { artist: string; title: string } | null {
  const i = text.indexOf(' - '); if (i <= 0) return null;
  const artist = text.slice(0, i).trim(), title = text.slice(i + 3).trim();
  return artist && title ? { artist, title } : null;
}
const words = (s: string) => fold(s).split(' ').filter(Boolean);
/** Every typed word is a whole word of the artist or the title ("drake" never matches "Drakeo the Ruler"). */
export function playingMatches(now: { artist: string; title: string }, query: string): boolean {
  const q = words(query); if (!q.length || q.join('').length < 2) return false;
  const have = new Set(words(`${now.artist} ${now.title}`));
  return q.every(w => have.has(w));
}
const wanted = (query: string) => /\p{L}/u.test(query) && words(query).join('').length >= 2;

export function parseTuneinPlaying(raw: string, query: string, now = Date.now()): PlayingStation[] {
  let body: unknown; try { body = (JSON.parse(raw) as { body?: unknown }).body; } catch { return []; }
  if (!Array.isArray(body)) return [];
  const out: PlayingStation[] = [];
  for (const o of body as Record<string, unknown>[]) {
    const guide = txt(o?.guide_id), name = txt(o?.text), playing = song(txt(o?.playing));
    if (o?.item !== 'station' || !GUIDE.test(guide) || !name || !playing || !playingMatches(playing, query)) continue;
    const image = publicUrl(txt(o.image)) ? txt(o.image).replace(/^http:/, 'https:') : '';
    const art = publicUrl(txt(o.playing_image)) ? txt(o.playing_image).replace(/^http:/, 'https:') : null;
    out.push({
      station: { id: `ti-${guide}`, name, url: tuneinTuneUrl(guide), homepage: '', image, country: '', countryCode: '', region: '', language: '', tags: [], codec: txt(o.formats).toUpperCase().split(',')[0] || '', bitrate: Number(o.bitrate) || 0, latitude: null, longitude: null },
      broadcast: { state: 'current', kind: 'song', artist: playing.artist, title: playing.title, source: 'TuneIn', checkedAt: now, artwork: art },
    });
  }
  return out;
}

/** TuneIn's now-playing feed. An ad or a station slogan has no track id ("o0" or none) and is not a song. */
export function parseTuneinNow(raw: string, now = Date.now()): Broadcast | null {
  let o: { Secondary?: { GuideId?: unknown; Title?: unknown; Image?: unknown } }; try { o = JSON.parse(raw); } catch { return null; }
  const s = o?.Secondary; if (!s || !/^o[1-9]\d*$/.test(txt(s.GuideId))) return null;
  const item = song(txt(s.Title)); if (!item) return null;
  const art = publicUrl(txt(s.Image)) ? txt(s.Image).replace(/^http:/, 'https:') : null;
  return { state: 'current', kind: 'song', artist: item.artist, title: item.title, source: 'TuneIn', checkedAt: now, artwork: art };
}

export interface TuneinDetails { guide: string; name: string; region: string; language: string; homepage: string; image: string; song: { artist: string; title: string } | null }
export function parseTuneinDescribe(raw: string): TuneinDetails | null {
  let body: unknown; try { body = (JSON.parse(raw) as { body?: unknown }).body; } catch { return null; }
  const o = Array.isArray(body) ? body.find(x => (x as { element?: unknown })?.element === 'station') as Record<string, unknown> | undefined : undefined;
  const guide = txt(o?.guide_id); if (!o || !GUIDE.test(guide)) return null;
  const artist = txt(o.current_artist), title = txt(o.current_song);
  return { guide, name: txt(o.name), region: txt(o.location), language: txt(o.language).toLowerCase(), homepage: publicUrl(txt(o.url)) ? txt(o.url) : '', image: publicUrl(txt(o.logo)) ? txt(o.logo) : '', song: artist && title ? { artist, title } : null };
}

export const songSearchUrl = (q: string) => `https://api.deezer.com/search?${new URLSearchParams({ q: q.trim().slice(0, 80), limit: '10' })}`;
/** The artists of songs whose names answer the search, in Deezer's order, at most two (the rest are covers). */
export function songArtists(raw: string, query: string): string[] {
  let data: unknown; try { data = (JSON.parse(raw) as { data?: unknown }).data; } catch { return []; }
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const x of data as { title?: unknown; artist?: { name?: unknown } }[]) {
    const artist = txt(x?.artist?.name), title = txt(x?.title);
    if (artist && title && playingMatches({ artist, title }, query) && !out.some(a => fold(a) === fold(artist))) out.push(artist);
    if (out.length === 2) break;
  }
  return out;
}

/** Finds the stations playing an artist or song right now. Every request is best effort; failure lists nothing. */
export class RadioPlayingNow {
  constructor(private readonly get: GetText) {}
  async search(query: string, now = Date.now()): Promise<PlayingStation[]> {
    if (!wanted(query)) return [];
    const ask = async (words: string) => { try { return parseTuneinPlaying(await this.get(tuneinSearchUrl(words)), query, now); } catch { return []; } };
    // TuneIn's search knows station names and artists, not song titles: a song is found through its artists.
    const [direct, artists] = await Promise.all([ask(query), this.get(songSearchUrl(query)).then(r => songArtists(r, query), () => [] as string[])]);
    const more = await Promise.all(artists.filter(a => fold(a) !== fold(query)).map(ask));
    const found = [...new Map([...direct, ...more.flat()].map(f => [f.station.id, f])).values()];
    const checked = await Promise.all(found.slice(0, 12).map(async f => {
      let d: TuneinDetails | null = null;
      try { d = parseTuneinDescribe(await this.get(tuneinDescribeUrl(tuneinGuide(f.station.id)!))); } catch { /* the search's own answer stands */ }
      if (!d) return f;
      // The search answer can be a minute old; the station's details are asked now and win when they disagree.
      if (d.song && !playingMatches(d.song, query)) return null;
      return { station: { ...f.station, region: d.region, language: d.language, homepage: d.homepage, image: f.station.image || d.image }, broadcast: d.song ? { ...f.broadcast, ...d.song } : f.broadcast };
    }));
    return checked.filter((x): x is PlayingStation => !!x);
  }
}
