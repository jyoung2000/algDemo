// Live: open every album a few searches find and compare songs loaded with the songs announced.
import { Albums } from '../src/engine/albums';
import { Deezer } from '../src/engine/deezer';
import { YouTubeMusic } from '../src/engine/ytmusic';
import { SoundCloud } from '../src/engine/soundcloud';
import { Http, HostPacer, type HttpPort } from '../src/engine/net';

const port: HttpPort = {
  async request(req, signal) {
    const res = await fetch(req.url, { method: req.method ?? 'GET', headers: req.headers ?? {}, ...(req.body !== undefined ? { body: req.body as BodyInit } : {}), ...(signal ? { signal } : {}), redirect: 'manual' });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
  },
};
const http = new Http(port, new HostPacer({}, 0));
const albums = new Albums(http, new Deezer(http), undefined, new YouTubeMusic(http), new SoundCloud(http));
const queries = (process.argv[2] ?? 'yeat 2093|playboi carti music|ken carson a great chaos|tyler the creator chromakopia|frank ocean blonde').split('|');
const short: string[] = [];
let n = 0;
for (const q of queries) {
  const r = await albums.search(q);
  for (const a of r.albums.slice(0, 10)) {
    try {
      const v = await albums.open(a.id);
      n++;
      const want = Math.max(v.count ?? 0, a.count ?? 0);
      const flag = want > v.tracks.length ? `  SHORT by ${want - v.tracks.length}` : '';
      console.log(`${a.id.padEnd(24)} ${v.tracks.length}/${want || '?'}  ${a.title.slice(0, 50)}${flag}`);
      if (flag) short.push(`${a.id} ${a.title} ${v.tracks.length}/${want}`);
    } catch (e) {
      console.log(`${a.id.padEnd(24)} FAILED ${(e as Error).message.slice(0, 80)}`);
      short.push(`${a.id} ${a.title} failed`);
    }
  }
}
console.log(`\nopened ${n}; short or failed: ${short.length}\n${short.join('\n')}`);
