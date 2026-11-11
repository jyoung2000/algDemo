// Live (ARTIST-PAGE-001): search each artist, open the top row, and report what the page would show:
// songs from each service, albums/EPs/singles, and whether every album named on the page opens.
import { Artists } from '../src/engine/artists';
import { Albums } from '../src/engine/albums';
import { Deezer } from '../src/engine/deezer';
import { YouTubeMusic } from '../src/engine/ytmusic';
import { SoundCloud } from '../src/engine/soundcloud';
import { Http, PACER, type HttpPort } from '../src/engine/net';

const port: HttpPort = {
  async request(req, signal) {
    const res = await fetch(req.url, { method: req.method ?? 'GET', headers: req.headers ?? {}, ...(req.body !== undefined ? { body: req.body as BodyInit } : {}), ...(signal ? { signal } : {}), redirect: 'manual' });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
  },
};
const http = new Http(port, PACER);
const dz = new Deezer(http);
const yt = new YouTubeMusic(http);
const albums = new Albums(http, dz, undefined, yt, new SoundCloud(http));
const artists = new Artists(http, dz, yt, undefined, albums);
const names = (process.argv[2] ?? 'ken carson|frank ocean|sza|my singing monsters|radiohead').split('|');
const openAll = process.argv[3] === 'open';
for (const q of names) {
  const t0 = Date.now();
  const found = await artists.search(q);
  const top = found[0];
  if (!top) { console.log(`${q}: NO ARTIST`); continue; }
  const v = await artists.open({ id: top.id, name: top.name });
  const ms = Date.now() - t0;
  const byProv = v.songs.reduce<Record<string, number>>((m, t) => ((m[t.provider] = (m[t.provider] ?? 0) + 1), m), {});
  const keys = new Set(v.songs.map((t) => t.key));
  console.log(`${q} -> ${v.name} (${v.id}, alt ${top.alt ?? '-'}) in ${ms} ms: ${v.songs.length} songs ${JSON.stringify(byProv)} dup=${v.songs.length - keys.size}; ${v.albums.length} albums/EPs, ${v.singles.length} singles; ${v.detail}; sources ${JSON.stringify(v.sources)}`);
  console.log(`   albums: ${v.albums.slice(0, 12).map((a) => `${a.title} (${a.year ?? '?'}, ${a.kind}, ${a.provider})`).join(' | ')}`);
  console.log(`   first songs: ${v.songs.slice(0, 6).map((t) => `${t.title} — ${t.artists.join(', ')} [${t.duration}s]`).join(' | ')}`);
  // ARTIST-FEATURES-001: the songs other artists have them on, which the page lists under Features.
  console.log(`   features: ${v.features.length}${v.features.length ? ` -> ${v.features.slice(0, 5).map((t) => `${t.title} — ${t.artists.join(', ')}`).join(' | ')}` : ''}`);
  const noDur = v.songs.filter((t) => !t.duration).length;
  if (noDur) console.log(`   songs without a duration: ${noDur}`);
  const t1 = Date.now();
  const all = await artists.everySong(v);
  const allKeys = new Set(all.songs.map((t) => t.key));
  console.log(`   every song: ${all.songs.length} (dup=${all.songs.length - allKeys.size}) from ${all.opened} album pages, ${all.failed} unread, in ${Date.now() - t1} ms`);
  if (openAll) {
    let bad = 0;
    for (const a of [...v.albums, ...v.singles]) {
      try { const x = await albums.open(a.id); if (!x.tracks.length) { bad++; console.log(`   EMPTY ${a.id} ${a.title}`); } }
      catch (e) { bad++; console.log(`   FAILED ${a.id} ${a.title}: ${(e as Error).message.slice(0, 80)}`); }
    }
    console.log(`   opened ${v.albums.length + v.singles.length} album pages, ${bad} bad`);
  }
}
