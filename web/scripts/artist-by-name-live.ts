// Live (ARTIST-NAME-PICK-001): open an artist BY NAME ONLY — the path a guest artist's name in a
// song row takes — and report which artist opened and how many features the page would show.
import { Artists } from '../src/engine/artists';
import { Albums } from '../src/engine/albums';
import { Deezer } from '../src/engine/deezer';
import { YouTubeMusic } from '../src/engine/ytmusic';
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
const artists = new Artists(http, dz, yt, undefined, new Albums(http, dz, undefined, yt));
for (const name of (process.argv[2] ?? 'Drake|Rihanna|21 Savage|Kevin MacLeod').split('|')) {
  const v = await artists.open({ name });
  console.log(`${name} -> ${v.name} (${v.id}) ${v.detail}: ${v.songs.length} songs, ${v.albums.length} albums/EPs, ${v.singles.length} singles, ${v.features.length} features`);
  if (v.features.length) console.log(`   ${v.features.slice(0, 3).map((t) => `${t.title} — ${t.artists.join(', ')}`).join(' | ')}`);
}
