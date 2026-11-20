/**
 * ALLOWANCE-ARCH-001: YouTube Music answers were about 80 % of everything the allowance was charged, and most of each
 * answer was never read. Measured 2026-11-20 (unpacked / on the wire):
 *   songs search   683,896 / 39,350  ->  53,970 / 5,529   with only the parts a row is read from (same 20 rows)
 *   watch ("next") 1,804,619 / 106,749  ->  81,725 / 11,228   (same 50 rows)
 * Every request now asks for compact JSON, and the search and watch requests ask for only those parts; if YouTube
 * refuses the short form the whole page is asked for once, as before.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { YouTubeMusic, parseSearchSongs, parseWatch } from './ytmusic';
import { BudgetExceeded } from './net';

const golden = (name: string) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'golden', name), 'utf8'));

/** A field mask as the service applies it: `a.b(c,d.e),f`; lists are looked through. */
type Tree = { [k: string]: Tree };
function maskTree(mask: string): Tree {
  let i = 0;
  const list = (): Tree => {
    const out: Tree = {};
    for (;;) {
      let node = out;
      for (;;) {
        let name = '';
        while (i < mask.length && !'.,()'.includes(mask[i]!)) name += mask[i++];
        node = node[name] ??= {};
        if (mask[i] === '.') { i++; continue; }
        break;
      }
      if (mask[i] === '(') { i++; Object.assign(node, list()); i++; }
      if (mask[i] === ',') { i++; continue; }
      return out;
    }
  };
  return list();
}
function project(v: unknown, t: Tree): unknown {
  if (!Object.keys(t).length) return v;
  if (Array.isArray(v)) return v.map((x) => project(x, t));
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, sub] of Object.entries(t)) if (k in (v as object)) out[k] = project((v as Record<string, unknown>)[k], sub);
  return out;
}
const fieldsOf = (url: string): string | null => new URL(url).searchParams.get('fields');

/** A service that answers the golden page, cut down to the asked-for parts exactly as the real one does. */
function service(page: unknown, refuseMask = false) {
  const asked: { url: string; body: Record<string, unknown> }[] = [];
  const http = {
    wait: async () => undefined,
    getJson: async (url: string, o: { body: string }) => {
      asked.push({ url, body: JSON.parse(o.body) });
      const fields = fieldsOf(url);
      if (fields && refuseMask) throw new Error('HTTP 400 from music.youtube.com');
      return fields ? project(page, maskTree(fields)) : page;
    },
  };
  return { ytm: new YouTubeMusic(http as never), asked };
}

describe('only the parts that are read are asked for', () => {
  it('a songs search asks for the short form and reads the same songs from it', async () => {
    const page = golden('ytm-search.json');
    const { ytm, asked } = service(page);
    const rows = await ytm.search('q', 50, {});
    const whole = parseSearchSongs(page).map((x) => ytm.toTrack(x, 'song'));
    expect(asked).toHaveLength(1);
    expect(fieldsOf(asked[0]!.url)).toBeTruthy();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toEqual(whole);
  });
  it('a videos search does the same', async () => {
    const page = golden('ytm-search.json');
    const { ytm, asked } = service(page);
    const rows = await ytm.searchVideos('q', 50, {});
    expect(fieldsOf(asked[0]!.url)).toBeTruthy();
    expect(rows).toEqual(parseSearchSongs(page).map((x) => ytm.toTrack(x)));
  });
  it('the watch panel (a song, its radio) does the same, related tab included', async () => {
    const page = golden('ytm-watch.json');
    const { ytm, asked } = service(page);
    const got = await (ytm as unknown as { watch(v: string, n: number, c: object, radio?: boolean): Promise<ReturnType<typeof parseWatch>> }).watch('abcdefghijk', 50, {}, true);
    const whole = parseWatch(page);
    expect(fieldsOf(asked[0]!.url)).toBeTruthy();
    expect(got.tracks.length).toBeGreaterThan(0);
    expect(got.tracks).toEqual(whole.tracks.slice(0, 50));
    expect(got.related).toBe(whole.related);
  });
  it('the short form leaves out what is never read', async () => {
    const size = (v: unknown) => JSON.stringify(v).length;
    const search = golden('ytm-search.json');
    const s = service(search);
    await s.ytm.search('q', 5, {});
    expect(size(project(search, maskTree(fieldsOf(s.asked[0]!.url)!)))).toBeLessThan(size(search));
    const panel = golden('ytm-watch.json');
    const w = service(panel);
    await w.ytm.song('abcdefghijk', {}).catch(() => undefined);
    expect(size(project(panel, maskTree(fieldsOf(w.asked[0]!.url)!)))).toBeLessThan(size(panel));
  });
});

describe('every request asks for compact JSON', () => {
  it('search, watch, artist and album pages all say prettyPrint=false', async () => {
    const { ytm, asked } = service(golden('ytm-artist.json'));
    await ytm.search('q', 5, {}).catch(() => undefined);
    await ytm.browse('UC' + 'a'.repeat(22), {}).catch(() => undefined);
    await ytm.albumSearch('q', {}).catch(() => undefined);
    await ytm.artistSearch('q', {}).catch(() => undefined);
    await ytm.albumPage('MPREb_' + 'a'.repeat(11), {}).catch(() => undefined);
    expect(asked.length).toBeGreaterThanOrEqual(4);
    for (const a of asked) expect(new URL(a.url).searchParams.get('prettyPrint'), a.url).toBe('false');
    for (const a of asked) expect(a.url.match(/prettyPrint/g)!.length, a.url).toBe(1);
  });
});

describe('when the short form is refused', () => {
  it('the whole page is asked for once, and the songs still come back', async () => {
    const page = golden('ytm-search.json');
    const { ytm, asked } = service(page, true);
    const rows = await ytm.search('q', 50, {});
    expect(asked.map((a) => Boolean(fieldsOf(a.url)))).toEqual([true, false]);
    expect(rows).toEqual(parseSearchSongs(page).map((x) => ytm.toTrack(x, 'song')));
  });
  it('the watch panel falls back the same way', async () => {
    const page = golden('ytm-watch.json');
    const { ytm, asked } = service(page, true);
    const got = await (ytm as unknown as { watch(v: string, n: number, c: object): Promise<ReturnType<typeof parseWatch>> }).watch('abcdefghijk', 50, {});
    expect(asked.map((a) => Boolean(fieldsOf(a.url)))).toEqual([true, false]);
    expect(got.tracks.length).toBeGreaterThan(0);
  });
  it('a spent allowance or "slow down" is not answered by asking for the big page', async () => {
    const asked: string[] = [];
    const http = { wait: async () => undefined, getJson: async (url: string) => { asked.push(url); throw new BudgetExceeded('transfer allowance for this request is used up'); } };
    await expect(new YouTubeMusic(http as never).search('q', 5, {})).rejects.toBeInstanceOf(BudgetExceeded);
    expect(asked).toHaveLength(1);
  });
});
