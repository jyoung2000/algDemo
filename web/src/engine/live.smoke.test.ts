// Live end-to-end run of the in-app engine against the real services. Skipped unless AIRWAVE_LIVE=1.
// AIRWAVE_AUDIO=1 also loads the real ONNX model; AIRWAVE_OUT=<file> receives a readable report.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Encoder, type OrtLike } from './encoder';
import { LocalApi } from './local-api';
import type { HttpPort } from './net';
import { MemoryBackend, Store } from './store';

const live = process.env['AIRWAVE_LIVE'] === '1';
const dir = new URL('../../../.data/models/', import.meta.url);
const port: HttpPort = {
  async request(req, signal) {
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

describe.skipIf(!live)('LocalApi live', () => {
  it('search, seed, recommend', async () => {
    const out: string[] = [];
    const save = () => writeFileSync(process.env['AIRWAVE_OUT'] ?? 'live.out.txt', out.join('\n'));
    const store = await Store.open(new MemoryBackend());
    let enc: Encoder | null = null;
    if (existsSync(new URL('model_epoch_36.onnx.data', dir)) && process.env['AIRWAVE_AUDIO'] === '1') {
      const ort = (await import('onnxruntime-web')) as unknown as OrtLike;
      enc = new Encoder(ort, async () => ({
        model: new Uint8Array(readFileSync(new URL('model_epoch_36.onnx', dir))),
        data: new Uint8Array(readFileSync(new URL('model_epoch_36.onnx.data', dir))),
      }));
    }
    // Windows shell's spotDL search, run for real (the shell is the only place spotDL exists).
    const { createRequire } = await import('node:module');
    const shell = createRequire(import.meta.url)('../../../windows/downloads.cjs') as { createDownloads: (c: Record<string, string>) => { handle: (r: Record<string, unknown>) => { songs: unknown[] } } };
    const dl = shell.createDownloads({ toolsDir: 'C:/Users/jalon/projects/AudioWave2.0/AudioWave2.0-claude-now-playing-music-suite-tfzu57/discovery-demo/.data/tools', saveDir: 'C:/tmp-unused', tempRoot: 'C:/Users/jalon/AppData/Local/hermes/cache/scratch/spotjobs' });
    const { searchSpotify } = await import('./spotify-search');
    const api = new LocalApi({ store, port, encoder: enc, spotifySearch: () => (q: string, n: number) => searchSpotify(async (query, k) => dl.handle({ op: 'spotify-search', query, limit: k }).songs, q, n) as never });
    try {
      const s = (await api.handle('GET', '/api/search?q=' + encodeURIComponent('daft punk around the world'))).body as any;
      out.push(`search sources ${JSON.stringify(s.sources)} results ${s.results?.length}`);
      for (const r of (s.results ?? []).slice(0, 4)) out.push(`  ${r.provider}: ${r.title} - ${r.artists?.join(', ')}`);
      expect(s.results.length).toBeGreaterThan(2);
      const put = await api.handle('PUT', '/api/seeds', { seeds: s.results.slice(0, 2) });
      out.push(`seeds ${put.status}`);
      expect(put.status).toBe(200);
      const id = ((await api.handle('POST', '/api/recommend')).body as any).job;
      let st: any;
      for (let i = 0; i < 240; i++) {
        st = (await api.handle('GET', '/api/jobs/' + id)).body;
        if (st.done) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      out.push(`job phase=${st.phase} error=${st.error} sources=${JSON.stringify(st.sources)}`);
      out.push(`timings ${JSON.stringify(st.result?.timings)} audio ${JSON.stringify(st.result?.audio)}`);
      for (const x of (st.result?.items ?? []).slice(0, 8)) out.push(`  ${x.rank}. ${x.track.title} - ${x.track.artists?.join(', ')} [${x.tier}] ${JSON.stringify(x.reasons?.[0] ?? '')}`);
      expect(st.error).toBeNull();
      expect(st.result.items.length).toBeGreaterThan(5);
    } catch (e) {
      out.push(`FAILED ${(e as Error).stack}`);
      throw e;
    } finally {
      save();
    }
  }, 300_000);
});
