// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadioStation } from './engine/radio';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RADIO_REFRESH_ORIGIN, RADIO_REFRESH_PATHS, RADIO_REFRESH_RING } from './RadioGlyphs';
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
const f = vi.hoisted(() => ({ search: vi.fn(), countries: vi.fn(), favourites: vi.fn(), save: vi.fn(), probe: vi.fn(), setStations: vi.fn(), tune: vi.fn(), match: vi.fn(), openArtist: vi.fn(), playSong: vi.fn() }));
vi.mock('./engine/radio-client', () => ({
  matchSongBroadcast: (...a: unknown[]) => f.match(...a),
  radioDirectory: { page: async (...a: unknown[]) => { const stations = await f.search(...a); return { stations, nextOffset: stations.length === 24 ? Number((a[0] as {offset:number}).offset) + 24 : null }; }, search: (...a: unknown[]) => f.search(...a), countries: () => f.countries() },
  radioSession: { subscribe: () => () => {}, get: () => ({ station: null }), setStations: (a: unknown) => f.setStations(a) },
  favouriteStations: () => f.favourites(), saveFavouriteStations: (s: unknown) => f.save(s), stationMetadata: (s: RadioStation) => f.probe(s),
}));
const { Radio } = await import('./Radio');
const station = (id: string): RadioStation => ({ id, name: `Station ${id}`, url: `https://station-${id}.example/live`, homepage: '', image: '', country: 'Canada', countryCode: 'CA', region: 'Quebec', language: 'french', tags: ['jazz'], codec: 'MP3', bitrate: 128, latitude: 45, longitude: -73 });
let root: Root, host: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.clearAllMocks(); localStorage.clear(); f.countries.mockResolvedValue([{ name: 'CA', code: 'CA', count: 3 }]); f.search.mockResolvedValue([station('a'), station('b')]); f.favourites.mockResolvedValue([]); f.save.mockImplementation(async v => v); f.probe.mockImplementation(async s => ({ state: 'current', kind: 'song', title: `Song ${s.id}`, artist: 'Artist', source: 'Broadcaster', checkedAt: Date.now() })); f.match.mockResolvedValue(null); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
const type = (value: string) => act(async () => { const input = host.querySelector<HTMLInputElement>('.radio-search input[type=search]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 420)); });
async function mount() { await act(async () => root.render(<Radio onTune={f.tune} onOpenArtist={f.openArtist} onPlaySong={f.playSong} />)); await flush(); }
describe('world radio browse and favourites (RADIO-001)', () => {
  it('flips # to 0-9 and ABC back, finding WGCI under W, under 1, and with typed 107', async () => {
    const wgci={...station('wgci'),name:'107.5 WGCI'}; f.search.mockResolvedValue([wgci]);
    await mount();
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Stations beginning with W"]')!.click());await flush();
    expect(host.querySelector('.radio-station h2')?.textContent).toContain('107.5 WGCI');
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Show number index"]')!.click());await flush();
    const nums=host.querySelector('[aria-label="Station numbers"]')!;expect(nums).not.toBeNull();
    expect([...nums.querySelectorAll('button')].map(b=>b.textContent)).toEqual(['All','0','1','2','3','4','5','6','7','8','9','ABC']);
    await act(async()=>nums.querySelector<HTMLButtonElement>('[aria-label="Stations beginning with 1"]')!.click());await flush();
    expect(f.search).toHaveBeenLastCalledWith(expect.objectContaining({letter:'1'}));expect(host.querySelector('.radio-station h2')?.textContent).toContain('107.5 WGCI');
    await type('107');await flush();expect(f.search).toHaveBeenLastCalledWith(expect.objectContaining({query:'107',letter:''}));
    expect(host.querySelector('.radio-station h2')?.textContent).toContain('107.5 WGCI');
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Show alphabet index"]')!.click());await flush();
    expect(host.querySelector('[aria-label="Station alphabet"]')?.querySelectorAll('button')).toHaveLength(28);
  });

  it('applies the same alphabet to favourites without showing nonmatching pinned stations', async () => {
    f.favourites.mockResolvedValue([{...station('k'),name:'KEXP'},{...station('j'),name:'Jazz FM'}]);
    await mount();
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Stations beginning with K"]')!.click()); await flush();
    expect([...host.querySelectorAll('.radio-station h2')].map(x=>x.textContent)).toEqual(['KEXP']);
    await act(async()=> [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Station sections"] button')].find(b=>b.textContent?.startsWith('Starred'))!.click());await flush();
    expect([...host.querySelectorAll('.radio-station h2')].map(x=>x.textContent)).toEqual(['KEXP']);
  });
  it('keeps country and genre selections when the alphabet is changed or cleared', async () => {
    await mount();
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Country filter"]')!.click());
    await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.radio-search__menu [role=option]')].find(b=>b.textContent?.includes('Canada'))!.click());await flush();
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Genre filter"]')!.click());
    await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.radio-search__menu [role=option]')].find(b=>b.textContent?.includes('Jazz'))!.click());await flush();
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Stations beginning with K"]')!.click());await flush();
    expect(f.search).toHaveBeenLastCalledWith(expect.objectContaining({letter:'K',country:'CA',tag:'jazz',offset:0}));
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="All station initials"]')!.click());await flush();
    expect(f.search).toHaveBeenLastCalledWith(expect.objectContaining({letter:'',country:'CA',tag:'jazz',offset:0}));
  });
  it('replaces Worldwide with All stations and filters remotely by an A-Z letter without dropping existing country/genre constraints', async () => {
    await mount(); expect(host.querySelector('[aria-label="Station sections"]')?.textContent).toContain('All stations');
    expect(host.querySelector('[aria-label="Station sections"]')?.textContent).not.toContain('Worldwide');
    const alphabet = host.querySelector('[aria-label="Station alphabet"]')!; expect(alphabet).not.toBeNull();
    expect(alphabet.querySelectorAll('button')).toHaveLength(28);
    await act(async()=> (alphabet.querySelector('[aria-label="Stations beginning with K"]') as HTMLButtonElement).click()); await flush();
    expect(f.search).toHaveBeenLastCalledWith(expect.objectContaining({letter:'K',offset:0}));
    expect(alphabet.querySelector('[aria-label="Stations beginning with K"]')?.getAttribute('aria-pressed')).toBe('true');
    await act(async()=> (alphabet.querySelector('[aria-label="All station initials"]') as HTMLButtonElement).click()); await flush();
    expect(f.search).toHaveBeenLastCalledWith(expect.objectContaining({letter:'',offset:0}));
  });

  it('refreshes each displayed station on the twenty-second metadata tick', async () => {
    const timer = vi.spyOn(globalThis, 'setInterval');
    try {
      await mount();
      const tick = timer.mock.calls.filter(([, ms]) => ms === 20000).at(-1)?.[0];
      expect(typeof tick).toBe('function'); f.probe.mockClear();
      await act(async () => { (tick as () => void)(); }); await flush();
      expect(f.probe).toHaveBeenCalledTimes(2);
    } finally { timer.mockRestore(); }
  });

  it('loads names, locations and current items for every listed station', async () => {
    await mount(); expect(host.querySelector('h1')?.textContent).toBe('Radio'); expect(host.querySelectorAll('.radio-station')).toHaveLength(2);
    expect(host.textContent).toContain('Quebec, Canada');
    expect(host.querySelector('.radio-station')!.textContent).toContain('French');
    expect(host.querySelector('.radio-station')!.textContent).not.toContain('french'); expect(host.textContent).toContain('Song a'); expect(host.textContent).toContain('Song b'); expect(f.probe).toHaveBeenCalledTimes(2);
  });
  it('searches live while typing in one discover-style bar, without pressing a button', async () => {
    await mount();
    const form = host.querySelector('.radio-search')!;
    expect(form.classList.contains('search__form')).toBe(true);
    expect(form.querySelector('.search__icon')).not.toBeNull();
    expect(host.querySelector('.radio-search button[type=submit]')).toBeNull();
    f.search.mockClear(); f.search.mockResolvedValue([station('kexp')]);
    await type('KEX'); await type('KEXP'); await flush();
    expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'KEXP', offset: 0 }));
    expect(host.querySelector('.radio-station h2')?.textContent).toContain('Station kexp');
    const clear = host.querySelector<HTMLButtonElement>('.search__clear')!;
    expect(clear).not.toBeNull(); f.search.mockClear(); f.search.mockResolvedValue([station('a')]);
    await act(async () => clear.click()); await act(async () => { await new Promise(r => setTimeout(r, 420)); });
    expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ query: '', offset: 0 }));
  });
  it('selects genre, country and language from menus inside the search bar (RADIO-UI-004)', async () => {
    await mount();
    const sections = host.querySelector('[aria-label="Station sections"]')!;
    expect([...sections.querySelectorAll('button')].map(b => b.textContent)).toEqual(expect.arrayContaining(['All stations', 'Starred stations (0)']));
    expect(host.querySelector('[aria-label="Preferred genres"]')).toBeNull();
    expect(host.querySelector('.radio-sections--refine')).toBeNull();
    const field = host.querySelector('.radio-search .search__field')!;
    const genreBtn = field.querySelector<HTMLButtonElement>('[aria-label="Genre filter"]')!;
    const countryBtn = field.querySelector<HTMLButtonElement>('[aria-label="Country filter"]')!;
    const langBtn = field.querySelector<HTMLButtonElement>('[aria-label="Language filter"]')!;
    expect(genreBtn.textContent).toContain('Genre'); expect(countryBtn.textContent).toContain('Country'); expect(langBtn.textContent).toContain('Language');
    await act(async () => genreBtn.click());
    const menu = host.querySelector('.radio-search__menu')!;
    const jazz = [...menu.querySelectorAll<HTMLButtonElement>('[role=option]')].find(b => b.textContent?.includes('Jazz'))!;
    expect((jazz.querySelector('.radio-search__dot') as HTMLElement).style.getPropertyValue('--tone')).toBeTruthy();
    f.search.mockClear(); await act(async () => jazz.click()); await flush();
    expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ tag: 'jazz' }));
    expect(host.querySelector('.radio-search__menu')).toBeNull();
    expect(genreBtn.textContent).toContain('Jazz');
    await act(async () => countryBtn.click());
    const ca = [...host.querySelectorAll<HTMLButtonElement>('.radio-search__menu [role=option]')].find(b => /Canada/.test(b.textContent || ''))!;
    f.search.mockClear(); await act(async () => ca.click()); await flush();
    expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ country: 'CA', tag: 'jazz' }));
    expect(countryBtn.textContent).toContain('Canada');
    await act(async () => langBtn.click());
    const langInput = host.querySelector<HTMLInputElement>('.radio-search__menu input[aria-label="Language"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(langInput, 'french');
    langInput.dispatchEvent(new Event('input', { bubbles: true }));
    f.search.mockClear();
    await act(async () => host.querySelector<HTMLButtonElement>('.radio-search__menu [aria-label="Apply language"]')!.click()); await flush();
    expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ language: 'french' }));
    expect(langBtn.textContent).toContain('French');
    await act(async () => genreBtn.click());
    f.search.mockClear();
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.radio-search__menu [role=option]')].find(b => b.textContent === 'All genres')!.click()); await flush();
    expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ tag: '' }));
    expect(genreBtn.textContent).not.toContain('Jazz');
  });
  it('colours every directory tag, gives unknown topics a lively deterministic tone and drops codec noise', async () => {
    f.search.mockResolvedValue([{ ...station('a'), tags: ['jazz', 'rnb', 'local news', 'aac', '128', 'mp3'] }]);
    await mount();
    const row = host.querySelector('.radio-station')!;
    const bubbles = [...row.querySelectorAll('.radio-station__tags .genre')];
    expect(bubbles.map(b => b.textContent)).toEqual(['Jazz', 'R&B', 'Local news']);
    const tone = (i: number) => (bubbles[i] as HTMLElement).style.getPropertyValue('--tone');
    expect(tone(0)).toBeTruthy(); expect(tone(1)).toBeTruthy();
    expect(tone(2)).toBeTruthy(); expect(tone(2)).not.toBe('#8a8f98');
    expect(tone(2)).not.toBe(tone(0));
    const meta = row.querySelector('.radio-station__meta')!;
    expect(meta.textContent).toContain('MP3'); expect(meta.textContent).toContain('128 kbps');
    expect(row.querySelector('.radio-station__tags')!.textContent).not.toContain('Aac');
  });
  it('stars stations independently of songs and puts favourites first', async () => {
    f.favourites.mockResolvedValue([station('b')]); await mount(); expect(host.querySelector('.radio-station h2')?.textContent).toContain('Station b');
    await act(async () => (host.querySelector('[aria-label="Star station Station a"]') as HTMLButtonElement).click()); await flush();
    expect(f.save).toHaveBeenCalledWith([station('b'), station('a')]);
  });
  it('passes the ordered station context when tuning so previous/next switch stations', async () => {
    await mount(); const play = host.querySelector('[aria-label="Play Station b"]') as HTMLButtonElement;
    expect(play.querySelector('svg')).not.toBeNull();
    expect(play.textContent).toBe('');
    await act(async () => play.click());
    expect(f.setStations).toHaveBeenCalledWith([station('a'), station('b')]); expect(f.tune).toHaveBeenCalledWith(station('b'));
  });
  it('offers a dedicated starred-stations list', async () => {
    f.favourites.mockResolvedValue([station('b')]); await mount(); const button = [...host.querySelectorAll('button')].find(b => b.textContent?.startsWith('Starred stations'))!;
    await act(async () => button.click()); await flush(); expect(host.querySelectorAll('.radio-station')).toHaveLength(1); expect(host.querySelector('.radio-station h2')?.textContent).toContain('Station b');
  });
  it('never invents a programme if the broadcaster supplies none', async () => {
    f.probe.mockResolvedValue({ state: 'unavailable', kind: 'programme', title: '', artist: null, source: 'ICY', checkedAt: Date.now(), detail: 'No ICY metadata' });
    await mount(); expect(host.textContent).toContain('Programme information unavailable'); expect(host.textContent).not.toContain('Song a');
  });
});

describe('live information loading (RADIO-UI-006)', () => {
  it('spins a refresh arrow while station information is updating, then returns to the magnifier', async () => {
    const releases: (() => void)[] = [];
    f.probe.mockImplementation(() => new Promise(r => { releases.push(() => r({ state: 'current', kind: 'song', title: 'T', artist: 'A', source: 'B', checkedAt: Date.now() })); }));
    await mount();
    expect(host.querySelector('.radio-search .radio-refresh__icon')).not.toBeNull();
    await act(async () => { releases.splice(0).forEach(r => r()); await new Promise(r => setTimeout(r, 30)); });
    expect(host.querySelector('.radio-search .radio-refresh__icon')).toBeNull();
  });
  it('tries for cover art: broadcaster artwork first, then the matched song cover', async () => {
    f.search.mockResolvedValue([{ ...station('a'), image: '' }, { ...station('b'), image: '' }]);
    f.probe.mockImplementation(async s => ({ state: 'current', kind: 'song', title: `Song ${s.id}`, artist: 'Artist', source: 'B', checkedAt: Date.now(), artwork: s.id === 'a' ? 'https://cdn.example/broadcast-a.jpg' : undefined }));
    f.match.mockImplementation(async b => (b.title === 'Song b' ? { key: 'k', title: 'Song b', artist: 'Artist', artwork: 'https://cdn.example/cover-b.jpg' } : null));
    await mount(); await flush();
    const art = [...host.querySelectorAll<HTMLImageElement>('.radio-station__art img')].map(i => i.getAttribute('src'));
    expect(art).toEqual(['https://cdn.example/broadcast-a.jpg', 'https://cdn.example/cover-b.jpg']);
  });
});

describe('decluttered page with actionable names (RADIO-UI-008)', () => {
  it('drops the typing hint and the names-and-locations note; Play and Star sit in one row of buttons under the text (ROW-UNIFY-001)', async () => {
    await mount();
    expect(host.querySelector('.search__hint')).toBeNull();
    expect(host.textContent).not.toContain('Names and locations come from');
    expect(host.textContent).not.toContain('Type a station');
    // Owner, 2026-11-19: consistent buttons and rows across Discover, Radio and Saved. The station
    // row reads like a song row: text first, then [Play][Star], with a drawn star (not a text glyph).
    const row = host.querySelector('.radio-station')!;
    const actions = row.querySelector('.radio-station__body > .radio-station__actions.song-actions')!;
    expect(actions).not.toBeNull();
    expect([...actions.children].map(c => c.getAttribute('aria-label'))).toEqual(['Play Station a', 'Star station Station a']);
    expect(actions.querySelector('.radio-station__star svg')).not.toBeNull();
    expect(row.querySelector('h2')!.textContent).toBe('Station a');
    expect(row.querySelector('.radio-station__play')!.classList.contains('playbtn')).toBe(true);
  });
  it('keeps the name, location, now-playing line and tags as single lines that scroll when cut off (MARQUEE-001)', async () => {
    const long = 'An extremely long song title that keeps going well past the width of any phone screen ever made';
    f.probe.mockImplementation(async s => ({ state: 'current', kind: 'song', title: s.id === 'a' ? long : `Song ${s.id}`, artist: 'Artist', source: 'Broadcaster', checkedAt: Date.now() }));
    await mount(); await flush();
    const rows = [...host.querySelectorAll('.radio-station')];
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const info = row.querySelector('.radio-station__body > .radio-station__info')!;
      expect([...info.children].map(c => c.classList[0] ?? c.tagName.toLowerCase())).toEqual(['h2', 'radio-location', 'radio-now', 'radio-station__tags']);
      expect(info.querySelector('h2 .radio-station__name')!.textContent).toMatch(/^Station [ab]$/);
      expect(info.querySelector('h2 .radio-station__name')!.classList.contains('mq')).toBe(true);
      expect(info.querySelector('.radio-station__tags')!.textContent).toContain('Jazz');
      expect(row.querySelectorAll('.radio-station__tags')).toHaveLength(1);
      expect(info.querySelector('.radio-location')!.textContent).toContain('Canada');
      expect(info.querySelector('.radio-location .mq')).not.toBeNull();
      expect(info.querySelector('.radio-now > .radio-now__text .mq')).not.toBeNull();
    }
    const text = rows[0]!.querySelector('.radio-now__text')!;
    expect(text.textContent).toContain(long);
    expect(text.getAttribute('title')).toBe(`Artist — ${long}`);
    expect(rows[0]!.querySelector('.radio-station__play')!.getAttribute('aria-label')).toBe('Play Station a');
  });
  it('styles the text lines to stay on one line; the cut-off part scrolls instead of wrapping (RADIO-UI-011)', () => {
    const block = css.slice(css.indexOf('RADIO-UI-011'));
    const rule = (sel: string) => { const i = block.indexOf(`${sel} {`); expect(i, sel).toBeGreaterThan(-1); return block.slice(i, block.indexOf('}', i)); };
    for (const sel of ['.radio-station__info > .radio-location', '.radio-now > .radio-now__text']) {
      const r = rule(sel);
      for (const p of ['white-space: nowrap', 'overflow: hidden']) expect(r, sel).toContain(p);
    }
    expect(css).not.toMatch(/\.radio-station__playrow/);
  });
  it('opens the artist and plays the matched song from the now-playing line', async () => {
    const matched = { key: 'song-key', title: 'Song a', artist: 'Artist', duration: 200 };
    f.match.mockResolvedValue(matched);
    await mount(); await flush();
    const artist = host.querySelector<HTMLButtonElement>('.radio-station [aria-label="Open the artist Artist"]')!;
    expect(artist).not.toBeNull();
    await act(async () => artist.click());
    expect(f.openArtist).toHaveBeenCalledWith({ name: 'Artist' });
    const title = host.querySelector<HTMLButtonElement>('.radio-station [aria-label="Play the song Song a"]')!;
    expect(title).not.toBeNull();
    await act(async () => title.click());
    expect(f.playSong).toHaveBeenCalledWith(matched);
  });
});

describe('loading skeletons and the refresh glyph (RADIO-UI-010)', () => {
  it('shows the shared skeleton list while the directory loads, then develops the live rows in', async () => {
    let release!: (v: RadioStation[]) => void;
    f.search.mockImplementation(() => new Promise<RadioStation[]>(r => { release = r; }));
    await mount();
    const skel = host.querySelector('.skel-list');
    expect(skel).not.toBeNull();
    expect(skel!.getAttribute('aria-label')).toBe('Loading stations around the world…');
    expect(host.querySelectorAll('.skel-row').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('.radio-station')).toHaveLength(0);
    await act(async () => { release([station('a'), station('b')]); await new Promise(r => setTimeout(r, 20)); });
    expect(host.querySelector('.skel-list')).toBeNull();
    expect(host.querySelectorAll('.radio-station > .skel-develop')).toHaveLength(2);
  });
  it('renders the RADIO-UI-011 refresh arrow while metadata is checked: one arc and one head, line-icon weight', async () => {
    f.probe.mockImplementation(() => new Promise(() => {}));
    await mount();
    const icon = host.querySelector('.radio-search .search__icon .radio-refresh__icon')!;
    expect(icon).not.toBeNull();
    expect(icon.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(icon.getAttribute('stroke-width')).toBe('2'); // the icons.tsx line-icon weight, not 2.2
    expect(icon.getAttribute('stroke-linecap')).toBe('round');
    expect(icon.getAttribute('stroke-linejoin')).toBe('round');
    expect([...icon.querySelectorAll('path')].map(p => p.getAttribute('d'))).toEqual([...RADIO_REFRESH_PATHS]);
    expect(icon.querySelector('polyline')).toBeNull();
    expect(icon.innerHTML).not.toContain('M3 12a8 8 0 0 1 16 0'); // the half-circle is gone
    expect((icon as SVGElement).style.transformOrigin).toBe(RADIO_REFRESH_ORIGIN);
  });
});

/** Parses 'Mx yA r r 0 large sweep x y' and the head 'Mx yLx yLx y' into numbers. */
const nums = (d: string) => (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
describe('refresh arrow geometry (RADIO-UI-011)', () => {
  const [arc, head] = RADIO_REFRESH_PATHS;
  const [sx, sy, rx, ry, , large, sweep, ex, ey] = nums(arc);
  const { cx, cy, r } = RADIO_REFRESH_RING;
  const ang = (x: number, y: number) => Math.atan2(y - cy, x - cx);
  it('is one open clockwise arc of 270-300 degrees on the declared ring', () => {
    expect(arc).toMatch(/^M[\d.]+ [\d.]+A[\d.]+ [\d.]+ 0 1 1 [\d.]+ [\d.]+$/); // a single arc segment
    expect([rx, ry, large, sweep]).toEqual([r, r, 1, 1]);
    expect(Math.hypot(sx! - cx, sy! - cy)).toBeCloseTo(r, 1);
    expect(Math.hypot(ex! - cx, ey! - cy)).toBeCloseTo(r, 1);
    // Clockwise on screen (y down) means increasing angle from start to end.
    let deg = ((ang(ex!, ey!) - ang(sx!, sy!)) * 180) / Math.PI; if (deg <= 0) deg += 360;
    expect(deg).toBeGreaterThanOrEqual(270); expect(deg).toBeLessThanOrEqual(300);
    expect(deg).toBeCloseTo(RADIO_REFRESH_RING.sweep, 0);
  });
  it('has one arrowhead whose tip is the arc end, arms symmetric about the arc tangent', () => {
    expect(head).toMatch(/^M[\d.]+ [\d.]+L[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
    const [ax, ay, tx, ty, bx, by] = nums(head);
    expect([tx, ty]).toEqual([ex, ey]); // joins the arc in one round-joined corner: no gap, no overlap
    const a = Math.hypot(ax! - tx!, ay! - ty!), b = Math.hypot(bx! - tx!, by! - ty!);
    expect(a).toBeCloseTo(b, 1); expect(a).toBeGreaterThan(3.5); expect(a).toBeLessThan(5);
    // Direction of travel at the end of a clockwise arc, and the arms' mean direction: exactly backwards.
    const t = ang(ex!, ey!), fwd = [-Math.sin(t), Math.cos(t)];
    const mid = [(ax! + bx!) / 2 - tx!, (ay! + by!) / 2 - ty!], len = Math.hypot(mid[0]!, mid[1]!);
    expect((mid[0]! * fwd[0]! + mid[1]! * fwd[1]!) / len).toBeCloseTo(-1, 2);
    const spread = (Math.acos(((ax! - tx!) * (bx! - tx!) + (ay! - ty!) * (by! - ty!)) / (a * b)) * 180) / Math.PI;
    expect(spread).toBeGreaterThan(80); expect(spread).toBeLessThan(100);
  });
  it('stays inside the 24-unit grid with the stroke, and spins around the ring centre', () => {
    const pts = [...nums(head)]; for (let i = 0; i < 360; i++) { const q = (i * Math.PI) / 180; pts.push(cx + r * Math.cos(q), cy + r * Math.sin(q)); }
    for (const v of pts) { expect(v - 1).toBeGreaterThanOrEqual(0); expect(v + 1).toBeLessThanOrEqual(24); }
    const [ox, oy] = RADIO_REFRESH_ORIGIN.split(' ').map(parseFloat);
    expect((ox! / 100) * 24).toBeCloseTo(cx, 2); expect((oy! / 100) * 24).toBeCloseTo(cy, 2);
  });
});

describe('passive cover art re-pull (RADIO-ART-002/003)', () => {
  it('drops a cover URL that fails to load and quickly recovers a replacement in the background', async () => {
    f.search.mockResolvedValue([station('a')]);
    f.probe.mockImplementation(async s => ({ state: 'current', kind: 'song', title: `Song ${s.id}`, artist: 'Artist', source: 'Broadcaster', checkedAt: Date.now(), artwork: 'https://cdn.example/broken.jpg' }));
    await mount(); await flush();
    const img = host.querySelector<HTMLImageElement>('.radio-station__art img')!;
    expect(img.getAttribute('src')).toBe('https://cdn.example/broken.jpg');
    f.match.mockClear();
    f.match.mockResolvedValue({ key: 'song-a', title: 'Song a', artist: 'Artist', artwork: 'https://cdn.example/recovered.jpg' });
    await act(async () => { img.dispatchEvent(new Event('error')); });
    expect(host.querySelector('.radio-station__art img')).toBeNull(); // the failed URL leaves the DOM at once
    await act(async () => { await new Promise(r => setTimeout(r, 700)); }); // fast first retry, in the background
    expect(f.match).toHaveBeenCalledWith(expect.anything(), { force: true });
    expect(host.querySelector<HTMLImageElement>('.radio-station__art img')?.getAttribute('src')).toBe('https://cdn.example/recovered.jpg');
  });
  it('a manual refresh forces another cross-platform ask for songs whose cover is still missing', async () => {
    f.search.mockResolvedValue([station('a')]);
    await mount(); await flush();
    expect(host.querySelector('.radio-station__art img')).toBeNull(); // no cover anywhere yet
    f.match.mockClear();
    await act(async () => host.querySelector<HTMLButtonElement>('.radio-page__header button')!.click());
    expect(f.match).toHaveBeenCalledWith(expect.objectContaining({ kind: 'song', title: 'Song a' }), { force: true });
  });
});

describe('the artist a radio row opens (RADIO-ARTIST-001)', () => {
  it('opens "The Jackson 5" for the raw ICY "JACKSON 5, THE" when no catalogue match exists', async () => {
    f.search.mockResolvedValue([station('a')]);
    f.probe.mockImplementation(async () => ({ state: 'current', kind: 'song', title: 'ABC', artist: 'JACKSON 5, THE', source: 'Broadcaster ICY', checkedAt: Date.now() }));
    await mount(); await flush();
    const link = host.querySelector<HTMLButtonElement>('.radio-station .radio-now__link')!;
    expect(link.textContent).toBe('JACKSON 5, THE'); // what the broadcaster published stays on screen
    expect(link.getAttribute('aria-label')).toBe('Open the artist The Jackson 5');
    await act(async () => link.click());
    expect(f.openArtist).toHaveBeenCalledWith({ name: 'The Jackson 5' });
  });
  it('opens the matched catalogue artist with its provider id for a featured, upper-case credit', async () => {
    f.search.mockResolvedValue([station('a')]);
    f.probe.mockImplementation(async () => ({ state: 'current', kind: 'song', title: 'ABC (Remastered)', artist: 'THE JACKSON 5 FEAT. MICHAEL JACKSON', source: 'Broadcaster ICY', checkedAt: Date.now() }));
    f.match.mockResolvedValue({ key: 'dz-abc', title: 'ABC', artist: 'Jackson 5', artists: ['Jackson 5'], artist_ids: { deezer: '75332' }, duration: 180 });
    await mount(); await flush();
    const link = host.querySelector<HTMLButtonElement>('.radio-station [aria-label="Open the artist Jackson 5"]')!;
    expect(link).not.toBeNull();
    await act(async () => link.click());
    expect(f.openArtist).toHaveBeenCalledWith({ id: 'dz:75332', name: 'Jackson 5' });
  });
});

describe('live station information while the tab is open (RADIO-LIVE-001)', () => {
  afterEach(() => { vi.useRealTimers(); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); });
  const setVisibility = (v: 'visible' | 'hidden') => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v }); document.dispatchEvent(new Event('visibilitychange')); };
  it('re-asks every listed station on a 20 s cycle, accepting answers under 15 s old, and updates rows in place', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    f.probe.mockImplementation(async (s: RadioStation) => ({ state: 'current', kind: 'song', title: `Song ${s.id} #${++n}`, artist: 'Artist', source: 'Broadcaster', checkedAt: Date.now() }));
    await mount(); await flush();
    const calls = f.probe.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    const row = host.querySelector('.radio-station')!, text = row.querySelector('.radio-now__text')!;
    const before = text.textContent;
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(f.probe.mock.calls.length).toBe(calls + 2);
    expect(host.querySelector('.radio-station')).toBe(row); // the same row element: no remount, no skeleton
    expect(host.querySelector('.skel-list')).toBeNull();
    expect(row.querySelector('.radio-now__text')).toBe(text);
    expect(text.textContent).not.toBe(before);
  });
  it('pauses while the document is hidden and resumes when it is visible again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount(); await flush();
    setVisibility('hidden');
    const calls = f.probe.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(f.probe.mock.calls.length).toBe(calls);
    await act(async () => { setVisibility('visible'); await vi.advanceTimersByTimeAsync(10); });
    expect(f.probe.mock.calls.length).toBe(calls + 2);
  });
  it('once the browser reports which rows are on screen, only those rows are re-asked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let report!: (ids: string[]) => void; const observed: Element[] = [];
    const real = globalThis.IntersectionObserver;
    class FakeIO { constructor(cb: (e: { target: Element; isIntersecting: boolean }[]) => void) { report = ids => cb(observed.map(target => ({ target, isIntersecting: ids.includes((target as HTMLElement).dataset.stationId!) }))); } observe(el: Element) { observed.push(el); } disconnect() {} unobserve() {} }
    Object.assign(globalThis, { IntersectionObserver: FakeIO });
    try {
      f.search.mockResolvedValue(['a', 'b', 'c'].map(station));
      await mount(); await flush();
      expect(observed.map(e => (e as HTMLElement).dataset.stationId)).toEqual(['a', 'b', 'c']);
      await act(async () => { report(['a']); await vi.advanceTimersByTimeAsync(20000); });
      f.probe.mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
      expect(f.probe.mock.calls.map(c => (c[0] as RadioStation).id)).toEqual(['a']);
    } finally { Object.assign(globalThis, { IntersectionObserver: real }); }
  });
  it('never starts a second round while one is in flight, keeps three requests at most, and stops on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    f.search.mockResolvedValue(['a', 'b', 'c', 'd', 'e', 'f'].map(station));
    let active = 0, max = 0; const releases: (() => void)[] = [];
    f.probe.mockImplementation((s: RadioStation) => { active++; max = Math.max(max, active); return new Promise(r => releases.push(() => { active--; r({ state: 'current', kind: 'song', title: `Song ${s.id}`, artist: 'Artist', source: 'B', checkedAt: Date.now() }); })); });
    await mount(); await flush();
    expect(f.probe.mock.calls.length).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(40000); }); // two more cycles while the first is still out
    expect(f.probe.mock.calls.length).toBe(3);
    await act(async () => { for (let i = 0; i < 6; i++) { releases.splice(0).forEach(r => r()); await vi.advanceTimersByTimeAsync(5); } });
    expect(f.probe.mock.calls.length).toBe(6);
    expect(max).toBeLessThanOrEqual(3);
    await act(async () => root.unmount());
    root = createRoot(host); // afterEach unmounts again
    const calls = f.probe.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(f.probe.mock.calls.length).toBe(calls);
  });
});

describe('double-click a station row to play it (RADIO-DBLCLICK-001)', () => {
  const dbl = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
  it('plays the station when the row itself is double-clicked, and not on a single click', async () => {
    await mount(); await flush();
    const row = host.querySelector('.radio-station')!;
    await act(async () => { row.querySelector<HTMLElement>('.radio-location')!.click(); });
    expect(f.tune).not.toHaveBeenCalled();
    await dbl(row.querySelector('.radio-location')!);
    expect(f.tune).toHaveBeenCalledTimes(1);
    expect(f.tune).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(f.setStations).toHaveBeenCalled(); // the same queue the play button sets, for skip/shuffle
    await dbl(row.querySelector('.radio-station__art')!);
    expect(f.tune).toHaveBeenCalledTimes(2);
  });
  it('ignores double-clicks that start on the row\'s buttons and links', async () => {
    await mount(); await flush();
    const row = host.querySelector('.radio-station')!;
    for (const sel of ['.radio-station__star', '.radio-station__play', '.radio-now__link']) await dbl(row.querySelector(sel)!);
    expect(f.tune).toHaveBeenCalledTimes(0);
    expect(f.openArtist).not.toHaveBeenCalled();
  });
});
