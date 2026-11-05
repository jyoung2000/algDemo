// Live check of the source chain against the real services. Skipped unless AIRWAVE_LIVE=1.
//
// SOURCE-VIDEO-001: these four songs sat unavailable on the owner's device at 93/97. Measured
// against the live InnerTube endpoint, YouTube Music's songs catalogue does not contain the right
// recording for any of them, while the videos filter returns "ManePear's Official Theme Song" by
// Nombra101 at exactly the right length. This test asks the real engine and prints what each
// source actually answers, so a regression in the chain shows up as a real-world miss.
import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import type { HttpPort } from './net';
import { MemoryBackend, Store } from './store';

const live = process.env['AIRWAVE_LIVE'] === '1';

const hosts: string[] = [];
const port: HttpPort = {
  async request(req, signal) {
    try { hosts.push(new URL(req.url).host); } catch { /* not a URL we can attribute */ }
    const res = await fetch(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers ?? {},
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(signal ? { signal } : {}),
      redirect: 'manual',
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
  },
};

const STUCK = [
  { key: 's1', provider: 'deezer', platform_id: '1', title: 'Plant Island', artists: ['My Singing Monsters'], duration: 219 },
  { key: 's2', provider: 'deezer', platform_id: '2', title: 'Earth Island (feat. Werdos & Dipsters)', artists: ['My Singing Monsters', 'Werdos', 'Dipsters'], duration: 171 },
  { key: 's3', provider: 'deezer', platform_id: '3', title: "ManePear's Official Theme Song", artists: ['Nombra101'], duration: 195 },
  { key: 's4', provider: 'deezer', platform_id: '4', title: 'Aria Math (From "Minecraft") (Piano Cover)', artists: ['Piano Cartel'], duration: 290 },
];

describe.skipIf(!live)('the source chain, against the real services', () => {
  it('resolves the song that only exists as a YouTube video', async () => {
    const store = await Store.open(new MemoryBackend());
    const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });
    const found: Record<string, string> = {};
    for (const track of STUCK) {
      const before = hosts.length;
      const r = await api.handle('POST', '/api/full-song', { track, retry: true });
      const body = r.body as { id: string | null; url?: string; source: string; note?: string };
      const asked = [...new Set(hosts.slice(before))];
      found[track.title] = `${body.source}${body.id ? ' ' + body.id : ''}${body.url ? ' ' + body.url : ''}${body.note ? ' (' + body.note + ')' : ''}`;
      // eslint-disable-next-line no-console
      console.log(`  ${track.title} -> ${found[track.title]}\n      asked: ${asked.join(', ') || '(nothing)'}`);
    }
    // Every source must actually have been consulted, or a "none" proves nothing about the song.
    // api-v2 is the SoundCloud SEARCH endpoint: reaching only soundcloud.com and a-v2.sndcdn.com
    // means the client-id read ran and the search never did.
    expect(hosts.some(h => h.includes('youtube.com'))).toBe(true);
    expect(hosts).toContain('api-v2.soundcloud.com');
    // The one with a verified exact upload must now resolve, from the videos catalogue.
    const manePear = found["ManePear's Official Theme Song"]!;
    expect(manePear).not.toMatch(/^none/);
    expect(manePear).toMatch(/^video /);
  }, 300_000);
});
