// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as Api from './api';
import type { ArtistView as ArtistData, Track } from './api';

/**
 * FEATURES-ALL-001 — owner: "on the feature page ensure all features load".
 *
 * The songs other artists have this artist on came back inside the every-song answer, so they waited for
 * every album to be read and were lost whenever that one long request failed. They are now asked for on
 * their own, beside the songs: the song list never waits on them, the page says so while they are being
 * found, and "Look again" asks for the features alone.
 */
const artistCall = vi.fn();
const songsCall = vi.fn();
const featuresCall = vi.fn();
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return { ...real, api: { ...real.api, artist: (a: unknown) => artistCall(a), artistSongs: (a: unknown) => songsCall(a), artistFeatures: (a: unknown) => featuresCall(a), artistSources: () => Promise.resolve({ songs: [], albums: [], singles: [], sources: {} }) } };
});
const { ArtistView, SONGS_FOLDED } = await import('./Artists');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const song = (k: string, title: string, artists = ['Ken Carson']): Track =>
  ({ key: k, title, artist: artists.join(', '), artists, album: 'A Great Chaos', duration: 150, artwork: null, preview: null, provider: 'deezer', platform_id: k, release: null, tags: [], artist_ids: { deezer: '2568121' } }) as unknown as Track;
const feature = (k: string, title: string, lead = 'Lil Tecca'): Track => ({ ...song(k, title, [lead, 'Ken Carson']), artist_ids: { deezer: '14492701' } }) as unknown as Track;
const popular = Array.from({ length: 4 }, (_, i) => song(`p${i}`, `Popular ${i + 1}`));
const view: ArtistData = {
  id: 'dz:2568121', name: 'Ken Carson', picture: null, detail: null, songs: popular, albums: [], singles: [], features: [feature('f0', 'Fell In Love')],
  links: { deezer: 'https://www.deezer.com/artist/2568121' }, sources: { deezer: { state: 'ok', count: 4 } },
} as unknown as ArtistData;
const SONGS = { songs: popular, opened: 0, failed: 0 };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  artistCall.mockResolvedValue({ artist: view });
  songsCall.mockResolvedValue(SONGS);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  for (const f of [artistCall, songsCall, featuresCall]) f.mockReset();
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const open = async () => {
  await act(async () => root.render(<ArtistView target={{ id: 'dz:2568121', name: 'Ken Carson' }} onBack={() => {}} onPreview={() => {}} onOpenAlbum={() => {}} onOpenArtist={() => {}} seedKeys={new Set()} onAdd={() => {}} />));
  await flush();
};
const byText = (t: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(t));
const titles = (label: string) => [...host.querySelectorAll(`ul[aria-label="${label}"] .track__title`)].map((x) => x.textContent?.trim());
const featuresOnly = () => act(async () => host.querySelector<HTMLButtonElement>('.typefilter__btn[data-type="features"]')!.click());

it('asks for the features on their own, beside the songs, and lists the songs without waiting for them', async () => {
  let land: (v: unknown) => void = () => {};
  featuresCall.mockReturnValue(new Promise((r) => (land = r)));
  await open();
  expect(featuresCall).toHaveBeenCalledWith({ id: 'dz:2568121', name: 'Ken Carson' });
  expect(songsCall).toHaveBeenCalledTimes(1);
  // The songs are all there, and the one feature the page opened with.
  expect(host.textContent).not.toContain('Finding every song');
  expect(titles('Songs by Ken Carson')).toEqual(popular.map((t) => t.title));
  expect(titles('Songs featuring Ken Carson')).toEqual(['Fell In Love']);
  // The wait is named, in the features' own section.
  expect(host.querySelector('.artist__feat-wait')?.textContent).toContain('Looking for more songs other artists have Ken Carson on');

  await act(async () => { land({ features: [feature('f0', 'Fell In Love'), feature('late', 'Late Guest', 'Yeat')], complete: true }); });
  await flush();
  // Added once each, the page's own first.
  expect(titles('Songs featuring Ken Carson')).toEqual(['Fell In Love', 'Late Guest']);
  expect(host.querySelector('.artist__feat-wait')).toBeNull();
  expect(host.textContent).not.toContain('Not every feature');
  expect(host.querySelector('.album__meta')!.textContent).toContain('2 features');
});

it('shows every feature found, behind one button once there are more than a screenful', async () => {
  const many = Array.from({ length: 37 }, (_, i) => feature(`m${i}`, `Guest ${i + 1}`, 'Playboi Carti'));
  featuresCall.mockResolvedValue({ features: many, complete: true });
  await open();
  expect(titles('Songs featuring Ken Carson')).toHaveLength(SONGS_FOLDED);
  await act(async () => byText('Show all 38 features')!.click());
  expect(titles('Songs featuring Ken Carson')).toEqual(['Fell In Love', ...many.map((t) => t.title)]);
});

it('says so when the artist had no features on the page and they are still being looked for', async () => {
  artistCall.mockResolvedValue({ artist: { ...view, features: [] } });
  let land: (v: unknown) => void = () => {};
  featuresCall.mockReturnValue(new Promise((r) => (land = r)));
  await open();
  await featuresOnly();
  // The features filter never says "nothing of that kind" while the answer is still on its way.
  expect(host.textContent).not.toContain('has nothing of that kind here');
  expect(host.querySelector('.artist__feat-wait')?.textContent).toContain('Looking for');
  await act(async () => { land({ features: [], complete: true }); });
  await flush();
  expect(host.textContent).toContain('has nothing of that kind here');
});

it('keeps the songs and says the features may be missing when they could not be looked up, and looks again for the features alone', async () => {
  featuresCall.mockRejectedValue(new Error('offline'));
  await open();
  expect(titles('Songs by Ken Carson')).toEqual(popular.map((t) => t.title));
  expect(host.textContent).toContain('Not every feature could be looked up');
  featuresCall.mockResolvedValue({ features: [feature('late', 'Late Guest', 'Yeat')], complete: true });
  await act(async () => byText('Look again')!.click());
  await flush();
  expect(host.textContent).not.toContain('Not every feature could be looked up');
  expect(titles('Songs featuring Ken Carson')).toEqual(['Fell In Love', 'Late Guest']);
  // The songs were not asked for a second time.
  expect(songsCall).toHaveBeenCalledTimes(1);
});

it('keeps the features already found when a second look finds fewer', async () => {
  featuresCall.mockResolvedValue({ features: [feature('late', 'Late Guest', 'Yeat')], complete: false });
  await open();
  expect(host.textContent).toContain('Not every feature could be looked up');
  featuresCall.mockResolvedValue({ features: [feature('other', 'Other Guest', 'Yeat')], complete: true });
  await act(async () => byText('Look again')!.click());
  await flush();
  expect(titles('Songs featuring Ken Carson')).toEqual(['Fell In Love', 'Late Guest', 'Other Guest']);
});

/**
 * FEATURES-ALL-002 — owner: "the artist page only loads like 8 features, ensure it loads all pages".
 * With the Features type chosen the page is the feature list, so it shows all of them: ten and a
 * "Show all" link read as "only ten loaded".
 */
it('lists every feature when Features is the chosen type, with nothing left to unfold', async () => {
  const many = Array.from({ length: SONGS_FOLDED + 13 }, (_, i) => feature(`m${i}`, `Guest ${i + 1}`));
  featuresCall.mockResolvedValue({ features: many, complete: true });
  await open();
  await flush();
  // The whole page still opens folded, so the albums stay in reach.
  expect(titles('Songs featuring Ken Carson')).toHaveLength(SONGS_FOLDED);
  expect(byText('Show all')?.textContent).toContain(`${many.length + 1} features`);
  await featuresOnly();
  expect(titles('Songs featuring Ken Carson')).toHaveLength(many.length + 1);
  expect(byText('Show all')).toBeUndefined();
});

it('says how many features there are in the Features heading', async () => {
  featuresCall.mockResolvedValue({ features: [feature('m1', 'Guest 1'), feature('m2', 'Guest 2')], complete: true });
  await open();
  await flush();
  const h = [...host.querySelectorAll('.albums__h')].find((x) => x.textContent?.startsWith('Features'));
  expect(h?.textContent).toBe('Features (3)');
});

/**
 * FEATURES-FLOW-001 — owner: "ensure features and artist discography information loads, ensure
 * everything loads as seamless as possible". A look for features takes up to a minute; the page asks
 * for it a few seconds at a time and lists what each answer has, instead of showing none until the end.
 */
it('lists the features as they are found, asking again while more remain', async () => {
  const lands: ((v: unknown) => void)[] = [];
  featuresCall.mockImplementation(() => new Promise((r) => lands.push(r)));
  await open();
  await featuresOnly();
  expect(lands).toHaveLength(1);
  await act(async () => { lands[0]!({ features: [feature('m1', 'Guest 1')], complete: true, more: true }); });
  await flush();
  // The first ones are on the page while the rest are still being looked for.
  expect(titles('Songs featuring Ken Carson')).toEqual(['Fell In Love', 'Guest 1']);
  expect(host.querySelector('.artist__feat-wait')).not.toBeNull();
  expect(lands).toHaveLength(2);
  await act(async () => { lands[1]!({ features: [feature('m1', 'Guest 1'), feature('m2', 'Guest 2')], complete: true, more: false }); });
  await flush();
  expect(titles('Songs featuring Ken Carson')).toEqual(['Fell In Love', 'Guest 1', 'Guest 2']);
  expect(host.querySelector('.artist__feat-wait')).toBeNull();
  expect(host.textContent).not.toContain('Not every feature');
  expect(lands).toHaveLength(2);
});

it('stops asking when the page is left', async () => {
  const lands: ((v: unknown) => void)[] = [];
  featuresCall.mockImplementation(() => new Promise((r) => lands.push(r)));
  await open();
  await act(async () => root.render(<div />));
  await act(async () => { lands[0]!({ features: [], complete: true, more: true }); });
  await flush();
  expect(lands).toHaveLength(1);
});

it('keeps what was found and offers to look again when a later answer fails', async () => {
  let n = 0;
  featuresCall.mockImplementation(() => (n++ === 0 ? Promise.resolve({ features: [feature('m1', 'Guest 1')], complete: true, more: true }) : Promise.reject(new Error('offline'))));
  await open();
  await flush();
  await flush();
  await featuresOnly();
  expect(titles('Songs featuring Ken Carson')).toEqual(['Fell In Love', 'Guest 1']);
  expect(host.textContent).toContain('Not every feature could be looked up');
});
