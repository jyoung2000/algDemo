// Live: album search across the four services, then open a YouTube Music and a SoundCloud album.
import { Albums } from '../src/engine/albums';
import { Deezer } from '../src/engine/deezer';
import { YouTubeMusic } from '../src/engine/ytmusic';
import { SoundCloud } from '../src/engine/soundcloud';
import { Http, HostPacer, type HttpPort } from '../src/engine/net';
import { makeTag } from '../src/engine/genres';
import { classifyAll } from '../src/engine/classify';

const port: HttpPort = {
  async request(req, signal) {
    const res = await fetch(req.url, { method: req.method ?? 'GET', headers: req.headers ?? {}, ...(req.body !== undefined ? { body: req.body as BodyInit } : {}), ...(signal ? { signal } : {}), redirect: 'manual' });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
  },
};
const http = new Http(port, new HostPacer({}, 0));
const sc = new SoundCloud(http);
const albums = new Albums(http, new Deezer(http), undefined, new YouTubeMusic(http), sc);

for (const q of ['ken carson a great chaos', 'frank ocean blonde', 'osamason flex musix', 'yeat 2093']) {
  const r = await albums.search(q);
  console.log(`\n## ${q}`);
  console.log('sources', Object.entries(r.sources).map(([k, v]) => `${k}:${v.state}${v.count !== undefined ? `(${v.count})` : ''}${v.detail ? ` ${v.detail}` : ''}`).join('  '));
  for (const a of r.albums.slice(0, 8)) console.log(`  ${a.id.padEnd(24)} ${a.title} — ${a.artist} · ${a.kind} · ${a.year ?? '-'} · ${a.count ?? '?'}${a.official === false ? ' · fan' : ''}`);
  const yt = r.albums.find((a) => a.provider === 'ytmusic');
  const s = r.albums.find((a) => a.provider === 'soundcloud');
  for (const pick of [yt, s]) {
    if (!pick) continue;
    const v = await albums.open(pick.id);
    console.log(`  OPEN ${pick.id}: ${v.title} — ${v.artist}, ${v.tracks.length}/${v.count} songs, ${v.duration}s; first: ${v.tracks.slice(0, 3).map((t) => `${t.title} (${t.duration}s, ${t.provider}, album_id=${t['album_id']})`).join(' | ')}`);
    const short = v.tracks.filter((t) => (t.duration ?? 0) > 0 && (t.duration ?? 0) <= 31);
    if (short.length) console.log(`  !! ${short.length} songs at 30 s or less`);
  }
}

// Genres the live SoundCloud songs carry, as bubbles would show them.
const tr = await sc.search('ken carson green room', 5);
for (const t of tr) console.log('SC genre', t.title, '|', JSON.stringify(t.tags.map((g) => g.label ?? g.name)), '->', classifyAll(t.tags, null).map((c) => c.subgenre ?? c.family).join(', '));
void makeTag;
