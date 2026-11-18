// @vitest-environment happy-dom
/**
 * MIXER-004: the crossfader as the page actually runs it.
 *
 * The previous attempt at this feature was fully unit-tested and still did nothing, because no
 * test rendered the player: the engine was imported and never called. These cases drive the real
 * component through a real DOM with a fake AudioContext, so "the blend happened" means two
 * elements were audible at once and the graph was told to fade between them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Player, type Playing, type UpNext } from './Player';
import { PREVIEW_ROUTE } from './engine/shape';
import { resetEngineForTests, setEqConfig, setLocalMix, setMixSlider } from './audio-engine';
import { queueAudio } from './engine/queue-audio';
import { EQ_DEFAULTS } from './engine/eq';

const { lookedUp, fullVersions, importedAnswers, held, started, nativeShell, embedded } = vi.hoisted(() => ({
  lookedUp: [] as string[],
  /** FOLDER-IMPORT-PLAY-001: songs the lookup answers with their own imported file link. */
  importedAnswers: new Map<string, string>(),
  /** Songs the page asked the model to analyse from the local file (FULL-SONG-EMBED-001). */
  embedded: [] as string[],
  nativeShell: { value: false },
  /** Songs the fake YouTube lookup reports a full version for. */
  fullVersions: new Set<string>(),
  /** Source links the fake shell holds a finished download for (LOCAL-AUDIO-001). */
  held: new Set<string>(),
  /** Downloads the page asked the fake shell to start. */
  started: [] as string[],
}));
vi.mock('./engine/downloads', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./engine/downloads')>();
  return {
    ...mod,
    downloadsAvailable: () => nativeShell.value,
    dl: {
      ...mod.dl,
      cacheConfig: vi.fn(async () => ({ bytes: 0, limitBytes: 1024 ** 3 })),
      local: (url: string) => Promise.resolve({ file: held.has(url) ? { name: 'song.opus', bytes: 1 } : null, running: started.includes(url) }),
      start: (url: string) => {
        started.push(url);
        return Promise.resolve({ job: { id: 'j' } });
      },
    },
  };
});
vi.mock('./api', () => ({
  api: {
    previewUrl: (route: string) => Promise.resolve({ url: `https://cdn.test/${route.split('/').pop()}.mp3` }),
    // The player looks for a full YouTube version of every song; these cases are about previews,
    // so the lookup answers "none found" and the preview path is the one under test.
    fullSong: (t: { key: string }) => {
      lookedUp.push(t.key);
      const imported = importedAnswers.get(t.key);
      if (imported) return Promise.resolve({ id: null, url: imported, source: 'imported' });
      return Promise.resolve({ id: fullVersions.has(t.key) ? 'dQw4w9WgXcQ' : null, confident: fullVersions.has(t.key) });
    },
    // Once a full song is on disk the player asks the model to hear it (FULL-SONG-EMBED-001). It is
    // fire-and-forget and nothing here depends on it, so the fake just records the request.
    embedLocal: (t: { key: string }, sourceUrl: string) => {
      embedded.push(`${t.key}|${sourceUrl}`);
      return Promise.resolve({ embedded: true, already: false, source: 'local-full-song-8seg', segments: 8, seconds: 180 });
    },
  },
}));

/** Every scheduled ramp, so a transition can be asserted instead of assumed. */
const ramps: { param: string; to: number; at: number }[] = [];
const sourced = new Set<unknown>();

function param(name: string) {
  const p = {
    value: 1,
    setValueAtTime: (v: number, at: number) => (ramps.push({ param: name, to: v, at }), p),
    linearRampToValueAtTime: (v: number, at: number) => (ramps.push({ param: `${name}:linear`, to: v, at }), p),
    exponentialRampToValueAtTime: (v: number, at: number) => (ramps.push({ param: `${name}:exp`, to: v, at }), p),
    setValueCurveAtTime: (c: ArrayLike<number>, at: number) => (ramps.push({ param: `${name}:curve`, to: c[c.length - 1] ?? 0, at }), p),
    cancelScheduledValues: () => p,
    cancelAndHoldAtTime: () => p,
  };
  return p;
}

function node(kind: string) {
  return {
    kind,
    connect: vi.fn((d: unknown) => d),
    disconnect: vi.fn(),
    gain: param(`${kind}.gain`),
    frequency: param(`${kind}.frequency`),
    Q: param(`${kind}.Q`),
    threshold: param(`${kind}.threshold`),
    knee: param(`${kind}.knee`),
    ratio: param(`${kind}.ratio`),
    attack: param(`${kind}.attack`),
    release: param(`${kind}.release`),
    detune: param(`${kind}.detune`),
    type: 'peaking',
  };
}

class FakeContext {
  state = 'running';
  currentTime = 0;
  destination = node('destination');
  resume = vi.fn(async () => { this.state = 'running'; });
  createGain = vi.fn(() => node('gain'));
  createBiquadFilter = vi.fn(() => node('biquad'));
  createDynamicsCompressor = vi.fn(() => node('compressor'));
  createAnalyser = vi.fn(() => ({ ...node('analyser'), fftSize: 2048, frequencyBinCount: 1024 }));
  createMediaElementSource = vi.fn((el: unknown) => {
    // The real constraint: one source node per element, for the page's life.
    if (sourced.has(el)) throw new DOMException('already connected', 'InvalidStateError');
    sourced.add(el);
    return node('source');
  });
}

/** happy-dom has no media pipeline: give the elements the parts the mixer reads and writes. */
function stubMedia() {
  const proto = globalThis.HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  const own = new WeakMap<object, Record<string, unknown>>();
  const bag = (el: object) => {
    let b = own.get(el);
    if (!b) own.set(el, (b = { paused: true, currentTime: 0, duration: 30, readyState: 4, seeking: false, ended: false }));
    return b;
  };
  for (const k of ['paused', 'currentTime', 'duration', 'readyState', 'seeking', 'ended']) {
    Object.defineProperty(proto, k, {
      configurable: true,
      get(this: object) { return bag(this)[k]; },
      set(this: object, v: unknown) { bag(this)[k] = v; },
    });
  }
  proto['play'] = vi.fn(async function (this: object) { bag(this)['paused'] = false; });
  proto['pause'] = vi.fn(function (this: object) { bag(this)['paused'] = true; });
  proto['load'] = vi.fn();
}

// The catalogue holds a stable route under PREVIEW_ROUTE, which the player exchanges for a signed
// URL. A fixture that does not match that prefix would skip the exchange and test nothing real.
const route = (key: string) => `${PREVIEW_ROUTE}${key}`;
const track = (key: string) => ({ key, title: `Song ${key}`, artist: `Artist ${key}`, duration: 30 });
const playing = (key: string): Playing => ({
  track: track(key) as Playing['track'],
  playback: { kind: 'preview', preview: route(key), provider: 'deezer', open: [], embed: null } as Playing['playback'],
});
const upNext = (key: string): UpNext[] => [{ key, title: `Song ${key}`, artist: 'A', artwork: null, preview: route(key), track: track(key) as UpNext['track'] }];

const props = {
  docked: false, canPrev: true, canNext: true, shuffle: false, repeat: 'off' as const,
  actions: { flags: {}, downloadState: 'idle' as const, downloadAvailable: false, onFeedback: vi.fn(), onDownload: vi.fn(), onDownloads: vi.fn() },
  onShuffle: vi.fn(), onRepeat: vi.fn(), onPrev: vi.fn(), onNext: vi.fn(), onListen: vi.fn(),
  onWheel: vi.fn(), onSelect: vi.fn(), onMenu: vi.fn(), onPickUpNext: vi.fn(),
};

const decks = () => [...document.querySelectorAll('audio')] as HTMLAudioElement[];
/** `paused` is read-only in the DOM types; the stub above makes it writable for these cases. */
const setPaused = (el: HTMLAudioElement, v: boolean) => {
  (el as unknown as Record<string, unknown>)['paused'] = v;
};
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => {
  vi.clearAllMocks();
  ramps.length = 0; sourced.clear();
  lookedUp.length = 0; fullVersions.clear(); held.clear(); started.length = 0; nativeShell.value = false;
  embedded.length = 0;
  stubMedia();
  stubBlobs();
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  resetEngineForTests();
  setMixSlider(0);
});
afterEach(() => { cleanup(); resetEngineForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function sourceEnded(a: HTMLAudioElement) {
  Object.defineProperty(a,'ended',{configurable:true,value:true});
  a.currentTime=Number.isFinite(a.duration)?a.duration:30;setPaused(a,true);
  a.dispatchEvent(new Event('ended'));
}

describe('the crossfader, rendered', () => {
  it('renders two permanent decks that opted into cross-origin processing', async () => {
    render(createElement(Player, { ...props, playing: playing('one'), upNext: upNext('two') }));
    await settle();
    const els = decks();
    expect(els).toHaveLength(2);
    // Without this attribute, routing the element through Web Audio yields permanent silence.
    for (const el of els) expect(el.getAttribute('crossorigin')).toBe('anonymous');
    expect(els.map((e) => e.dataset['deck'])).toEqual(['a', 'b']);
  });

  it('routes BOTH decks into the graph once the listener turns the mixer on', async () => {
    setMixSlider(60);
    render(createElement(Player, { ...props, playing: playing('one'), upNext: upNext('two') }));
    await settle();
    expect(sourced.size).toBe(2);
  });

  it('builds no graph at all while the mixer is off', async () => {
    render(createElement(Player, { ...props, playing: playing('one'), upNext: upNext('two') }));
    await settle();
    expect(sourced.size).toBe(0);
  });

  it('reports that the graph is really carrying the audio, not just that controls exist', async () => {
    // Without this the panel cannot be told apart from a broken one: if `attach` were refused
    // (a preview server without CORS), both songs would still play — at full level, unfaded —
    // and every control would look fine. The engine's reason is the only outside signal.
    const { reason } = await import('./audio-engine');
    expect(reason()).toBe('not-started');
    setMixSlider(80);
    render(createElement(Player, { ...props, playing: playing('one'), upNext: upNext('two') }));
    await settle();
    expect(reason()).toBe('ready');
  });

  it('keeps the outgoing source alone through 100%, then starts the next from zero',async()=>{
    setMixSlider(100);render(createElement(Player,{...props,playing:playing('one'),upNext:upNext('two')}));await settle();
    const [a,b]=decks() as [HTMLAudioElement,HTMLAudioElement];setPaused(a,false);
    for(const at of [28.6,29.999,30,31]) {a.currentTime=at;await act(async()=>{a.dispatchEvent(new Event('timeupdate'));});expect(b.paused).toBe(true);}
    expect(props.onNext).not.toHaveBeenCalled();
    await act(async()=>{sourceEnded(a);});await settle();
    expect(b.paused).toBe(false);expect(a.paused).toBe(true);expect(b.currentTime).toBe(0);expect(props.onNext).toHaveBeenCalledOnce();
  });

  it('describes waiting for full completion without claiming early beatmatching',async()=>{
    setMixSlider(100);const {container}=render(createElement(Player,{...props,playing:playing('one'),upNext:upNext('two')}));await settle();
    expect(container.querySelector('.np__note--mix')?.textContent).toMatch(/after 100%|Preparing/);
    const [a]=decks() as [HTMLAudioElement];a.currentTime=29.5;await act(async()=>{a.dispatchEvent(new Event('timeupdate'));});
    expect(container.querySelector('.np__note--mix')?.textContent).not.toMatch(/bass.swap|filter|beat.matched/i);
    expect(container.querySelector('.np__main .np__title')?.textContent).toBe('Song one');
  });

  it('plays the full song whenever one exists, mixer on or off — the owner’s rule', async () => {
    // Earlier this preferred the 30-second preview while the mixer was on, because only a
    // preview can be routed through the mixer. The owner rejected that trade: "both softwares
    // should play the full song not a 30 second preview". So the full song always wins, and the
    // mixer reaches only songs that have no full version.
    const withVideo = (key: string): Playing => ({
      track: { ...track(key), provider: 'ytmusic', platform_id: 'dQw4w9WgXcQ' } as Playing['track'],
      playback: { kind: 'full', preview: route(key), open: [], embed: null } as Playing['playback'],
    });
    setMixSlider(70);
    const { container } = render(createElement(Player, { ...props, playing: withVideo('one'), upNext: upNext('two') }));
    await settle();
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(decks().some((d) => d.getAttribute('src'))).toBe(false);
  });

  it('only cues a next song it has confirmed has no full version, so a blend never steals one', async () => {
    // The lookahead asks YouTube about the next song before cueing its preview. If a full version
    // exists, that song must play whole in its own player, so nothing is cued and the line says why.
    setMixSlider(100);
    fullVersions.add('two');
    const { container, rerender } = render(createElement(Player, { ...props, playing: playing('one'), upNext: upNext('two') }));
    await settle();
    expect(lookedUp).toContain('two');
    expect(decks()[1]?.getAttribute('src')).toBeNull();
    expect(container.querySelector('.np__note--mix')?.textContent).toMatch(/Next full song is not ready/);

    // A next song with no full version is cued as before.
    fullVersions.delete('two');
    rerender(createElement(Player, { ...props, playing: playing('one'), upNext: upNext('three') }));
    await settle();
    expect(decks()[1]?.getAttribute('src')).toBe('https://cdn.test/three.mp3');
  });

  it('keeps the promoted incoming playhead instead of restarting it',async()=>{
    setMixSlider(100);const onNext=vi.fn();const view=render(createElement(Player,{...props,onNext,playing:playing('one'),upNext:upNext('two')}));await settle();
    const [a,b]=decks() as [HTMLAudioElement,HTMLAudioElement];await act(async()=>{sourceEnded(a);});await settle();
    expect(b.paused).toBe(false);const before=vi.mocked(HTMLMediaElement.prototype.play).mock.contexts.filter(x=>x===b).length;b.currentTime=2;
    view.rerender(createElement(Player,{...props,onNext,playing:playing('two'),upNext:upNext('three')}));await settle();
    expect(b.currentTime).toBe(2);expect(vi.mocked(HTMLMediaElement.prototype.play).mock.contexts.filter(x=>x===b).length).toBe(before);
    expect(view.container.querySelector('.np__main .np__title')?.textContent).toBe('Song two');expect(onNext).toHaveBeenCalledOnce();
  });

  it('seeking while next waits leaves only current playing',async()=>{
    setMixSlider(100);render(createElement(Player,{...props,playing:playing('one'),upNext:upNext('two')}));await settle();
    const [a,b]=decks() as [HTMLAudioElement,HTMLAudioElement];
    fireEvent.change(screen.getByRole('slider',{name:/Position in the/}),{target:{value:'10'}});
    expect(b.paused).toBe(true);expect(a.currentTime).toBe(10);
  });

  it('blends nothing while repeating one song, because there is no next song', async () => {
    // Observed on the real app with repeat set to "this song": the mixer cued the next preview and
    // blended twelve audible seconds of it, then the repeat branch cancelled the blend and
    // restarted the current song — so the listener heard the next song fade in and get yanked.
    setMixSlider(100);
    const { rerender } = render(createElement(Player, { ...props, repeat: 'one', playing: playing('one'), upNext: upNext('two') }));
    await settle();
    const [a, b] = decks() as [HTMLAudioElement, HTMLAudioElement];
    expect(b.getAttribute('src')).toBeNull(); // never even cued
    setPaused(a, false);
    a.currentTime = 28.6; // the 95% point of a 30s deck has passed (MIXER-PLAY-THROUGH-001)
    await act(async () => { a.dispatchEvent(new Event('timeupdate')); });
    await settle();
    expect(b.paused).toBe(true);
    expect(ramps.filter((r) => r.param.includes('curve'))).toHaveLength(0);

    // Turning repeat back off re-arms the lookahead.
    rerender(createElement(Player, { ...props, repeat: 'off', playing: playing('one'), upNext: upNext('two') }));
    await settle();
    expect(b.getAttribute('src')).toBe('https://cdn.test/two.mp3');
  });

  it('cancels a prepared blend when the listener switches to repeat-one mid-song', async () => {
    setMixSlider(100);
    const { rerender } = render(createElement(Player, { ...props, repeat: 'off', playing: playing('one'), upNext: upNext('two') }));
    await settle();
    const [a, b] = decks() as [HTMLAudioElement, HTMLAudioElement];
    expect(b.getAttribute('src')).toBe('https://cdn.test/two.mp3');

    rerender(createElement(Player, { ...props, repeat: 'one', playing: playing('one'), upNext: upNext('two') }));
    await settle();
    setPaused(a, false);
    a.currentTime = 28.6; // the 95% point of a 30s deck has passed (MIXER-PLAY-THROUGH-001)
    await act(async () => { a.dispatchEvent(new Event('timeupdate')); });
    await settle();
    expect(b.paused).toBe(true);
    expect(ramps.filter((r) => r.param.includes('curve'))).toHaveLength(0);
  });

});

/**
 * LOCAL-AUDIO-001: the full song, through the decks.
 *
 * The owner's two rules collided: the full song always wins, and the equaliser and crossfader must
 * work. YouTube's iframe cannot be routed, so the way to satisfy both is a full song the page plays
 * itself — downloaded by the bundled yt-dlp and served at the app's own origin.
 */
const SRC = 'https://music.youtube.com/watch?v=dQw4w9WgXcQ';
/** The deck plays a Blob of the downloaded file, not the /local-audio address (LOCAL-AUDIO-002). */
const LOCAL = 'blob:local-song';
/** Hand the library a fetch and an object URL, as a browser would. */
const stubBlobs = () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g['fetch'] = vi.fn(async () => ({ ok: true, blob: async () => new Blob([new Uint8Array(4)]) }) as unknown as Response);
  (globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => LOCAL;
  (globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
};
const withVideo = (key: string): Playing => ({
  track: { ...track(key), provider: 'ytmusic', platform_id: 'dQw4w9WgXcQ', duration: 180 } as Playing['track'],
  playback: { kind: 'full', preview: route(key), open: [], embed: null } as Playing['playback'],
});

describe('full songs through the decks (LOCAL-AUDIO-001)', () => {
  beforeEach(() => { nativeShell.value = true; setLocalMix(true); });

  it('plays a downloaded full song on a deck, not in YouTube’s player, when the mixer or EQ wants it', async () => {
    held.add(SRC);
    setMixSlider(70);
    const { container } = render(createElement(Player, { ...props, playing: withVideo('one'), upNext: [] }));
    await settle();
    expect(container.querySelector('iframe')).toBeNull();
    expect(decks()[0]?.getAttribute('src')).toBe(LOCAL);
    expect(sourced.size).toBe(2); // both decks in the graph
    // happy-dom never fires canplay, so the note is still "Loading the full song…" — and that is
    // the point: it says full song, and never YouTube.
    expect(container.querySelector('.np__note')?.textContent).toMatch(/full song/i);
    expect(container.querySelector('.np__note')?.textContent).not.toMatch(/YouTube/);
  });

  it('prefers the imported file over a same-key catalogue copy already held in the queue, with EQ on', async () => {
    // Observed live: "Real Test Mix" played a downloaded YouTube copy instead of the file imported
    // from that playlist. Its shared song key made the queue's readyUrl win before the file's own URL.
    const IMP = 'imported:C:\\Music\\Mix\\Artist - One.opus';
    held.add(IMP); held.add(SRC);
    vi.spyOn(queueAudio, 'readyUrl').mockReturnValue(SRC);
    setEqConfig({ ...EQ_DEFAULTS, on: true, presetId: 'bass-booster', gains: [7, 5.5, 4, 2, 0, 0, 0, 0, 0, 0] });
    const ownFile = { ...playing('one'), track: { ...playing('one').track, provider: 'imported', url: IMP } } as unknown as Playing;
    render(createElement(Player, { ...props, playing: ownFile, upNext: [] }));
    await settle(); await settle();
    expect(globalThis.fetch).toHaveBeenCalledWith(`/local-audio?u=${encodeURIComponent(IMP)}`);
    expect(globalThis.fetch).not.toHaveBeenCalledWith(`/local-audio?u=${encodeURIComponent(SRC)}`);
    const { peekEngine } = await import('./audio-engine');
    expect(peekEngine().bus?.decks.a?.eq.on).toBe(true);
    expect(lookedUp).not.toContain('one'); // an imported file does not need a catalogue lookup
  });

  it('pre-loads an imported next song on the second deck so it gets the same entrance as any song', async () => {
    const IMP = 'imported:C:\\Music\\Mix\\Artist - Two.opus';
    held.add(SRC); held.add(IMP); importedAnswers.set('two', IMP);
    setMixSlider(70);
    const next: UpNext[] = [{ key: 'two', title: 'Two', artist: 'Artist', artwork: null, preview: null, track: { ...track('two'), provider: 'imported', url: IMP } as unknown as UpNext['track'] }];
    render(createElement(Player, { ...props, playing: withVideo('one'), upNext: next }));
    await settle(); await settle();
    expect(decks()[1]?.getAttribute('src')).toBe(LOCAL); // cued on the spare deck, not left for a cold load
    expect(decks()[1]?.paused).toBe(true);               // and silent until the current song ends
    importedAnswers.clear();
  });

  it('builds the graph for the equaliser alone, mixer off', async () => {
    held.add(SRC);
    setEqConfig({ ...EQ_DEFAULTS, on: true });
    render(createElement(Player, { ...props, playing: withVideo('one'), upNext: [] }));
    await settle();
    expect(decks()[0]?.getAttribute('src')).toBe(LOCAL);
    expect(sourced.size).toBe(2);
  });

  it('waits for a missing full song to load locally without an iframe or preview', async () => {
    setMixSlider(70);
    const { container } = render(createElement(Player, { ...props, playing: withVideo('one'), upNext: [] }));
    await settle();
    expect(started).toEqual([SRC]);
    expect(container.querySelector('iframe')).toBeNull();
    expect(decks()[0]?.getAttribute('src')).toBeNull();
    expect(container.textContent).toMatch(/Downloading the full song/i);
  });

  it('starts the newly downloaded song on the local deck, not in an iframe', async () => {
    setMixSlider(70);
    const { container } = render(createElement(Player, { ...props, playing: withVideo('one'), upNext: [] }));
    await settle();
    expect(container.querySelector('iframe')).toBeNull();
    held.add(SRC);
    const { localLibrary } = await import('./engine/local-audio');
    await act(async () => { await localLibrary.refresh(SRC); });
    await settle();
    expect(localLibrary.status(SRC)).toBe('ready');
    expect(container.querySelector('iframe')).toBeNull();
    expect(decks()[0]?.getAttribute('src')).toBe(LOCAL);
  });

  it('plays a held full song locally even with mixer and EQ off', async () => {
    held.add(SRC);
    const { container } = render(createElement(Player, { ...props, playing: withVideo('one'), upNext: [] }));
    await settle();
    expect(container.querySelector('iframe')).toBeNull();
    expect(decks()[0]?.getAttribute('src')).toBe(LOCAL);
  });

  it('lets the model hear the whole song once it is on disk, not Deezer\u2019s 30 seconds (FULL-SONG-EMBED-001)', async () => {
    held.add(SRC);
    render(createElement(Player, { ...props, playing: withVideo('one'), upNext: [] }));
    await settle();
    expect(embedded).toEqual([`one|${SRC}`]);
  });

  it('asks for that analysis once per song, however often the player re-renders', async () => {
    held.add(SRC);
    const { rerender } = render(createElement(Player, { ...props, playing: withVideo('one'), upNext: [] }));
    await settle();
    rerender(createElement(Player, { ...props, playing: withVideo('one'), upNext: [] }));
    await settle();
    expect(embedded).toEqual([`one|${SRC}`]);
  });

  it('ignores the legacy local_mix switch in installed apps', async () => {
    setLocalMix(false);
    held.add(SRC);
    const { container } = render(createElement(Player, { ...props, playing: withVideo('one'), upNext: [] }));
    await settle();
    expect(container.querySelector('iframe')).toBeNull();
    expect(decks()[0]?.getAttribute('src')).toBe(LOCAL);
  });

  it('cues a held full song as the next deck and blends into it — a full song, not a preview', async () => {
    held.add(SRC);
    setMixSlider(100);
    const nextFull: UpNext[] = [{ key: 'two', title: 'Song two', artist: 'A', artwork: null, preview: route('two'), track: withVideo('two').track }];
    fullVersions.add('two');
    render(createElement(Player, { ...props, playing: withVideo('one'), upNext: nextFull }));
    await settle();
    const [a, b] = decks() as [HTMLAudioElement, HTMLAudioElement];
    expect(b.getAttribute('src')).toBe(LOCAL);
    setPaused(a, false);
    a.currentTime = 28.6; // the 95% point of a 30s deck has passed (MIXER-PLAY-THROUGH-001)
    await act(async () => { a.dispatchEvent(new Event('timeupdate')); });
    await settle();
    expect(b.paused).toBe(true);expect(a.paused).toBe(false);
    await act(async()=>{sourceEnded(a);});await settle();
    expect(b.paused).toBe(false);expect(b.currentTime).toBe(0);
  });

  it('keeps the blended-into full song on its deck after the handoff — no restart, no YouTube', async () => {
    // Observed on the Windows app: the blend into a downloaded full song ran, then at the handoff
    // the new song was treated as a preview-only song, had no preview, and jumped to YouTube’s
    // player from 0:00 — the overlap the listener just heard was thrown away.
    held.add(SRC);
    setMixSlider(100);
    const two = withVideo('two');
    const nextFull: UpNext[] = [{ key: 'two', title: 'Song two', artist: 'A', artwork: null, preview: null, track: two.track }];
    fullVersions.add('two');
    const onNext = vi.fn();
    const view = render(createElement(Player, { ...props, onNext, playing: withVideo('one'), upNext: nextFull }));
    await settle();
    const [a, b] = decks() as [HTMLAudioElement, HTMLAudioElement];
    expect(b.getAttribute('src')).toBe(LOCAL);
    setPaused(a, false);
    a.currentTime = 28.6; // the 95% point of a 30s deck has passed (MIXER-PLAY-THROUGH-001)
    await act(async () => { a.dispatchEvent(new Event('timeupdate')); });
    await settle();
    expect(b.paused).toBe(true);
    await act(async()=>{sourceEnded(a);});await settle();
    expect(b.paused).toBe(false);b.currentTime=7;
    expect(onNext).toHaveBeenCalled();
    view.rerender(createElement(Player, { ...props, onNext, playing: two, upNext: [] }));
    await settle();
    expect(view.container.querySelector('iframe')).toBeNull();
    expect(b.getAttribute('src')).toBe(LOCAL);
    expect(b.paused).toBe(false);
    expect(b.currentTime).toBe(7);
    expect(view.container.querySelector('.np__note')?.textContent).not.toMatch(/YouTube/);
  });

  it('downloads the next full song ahead of time so the blend can reach it', async () => {
    setMixSlider(100);
    const nextFull: UpNext[] = [{ key: 'two', title: 'Song two', artist: 'A', artwork: null, preview: route('two'), track: withVideo('two').track }];
    fullVersions.add('two');
    const current = withVideo('one');
    current.track.platform_id = 'aaaaaaaaaaa';
    held.add('https://music.youtube.com/watch?v=aaaaaaaaaaa');
    const { container } = render(createElement(Player, { ...props, playing: current, upNext: nextFull }));
    await settle();
    expect(started).toEqual([SRC]);
    expect(container.querySelector('.np__note--mix')?.textContent).toMatch(/Downloading the next song/i);
  });
});


describe('CURRENT-PRIMARY-001 upcoming is secondary artwork only', () => {
  it.each([false,true])('keeps current art, title and progress primary when next metadata or loading events change (docked=%s)', async (docked) => {
    setMixSlider(60);
    const current={...playing('one'),track:{...playing('one').track,artwork:'https://art.test/current.jpg'}};
    const upcoming=[{...upNext('two')[0]!,artwork:'https://art.test/next.jpg'}];
    const {container,rerender}=render(createElement(Player,{...props,docked,playing:current,upNext:upcoming}));
    await settle();
    expect(container.querySelector('.np__main .np__title')?.textContent).toBe('Song one');
    expect(container.querySelector('.np__main img')?.getAttribute('src')).toBe('https://art.test/current.jpg');
    expect(container.querySelector('.np__upcoming img')?.getAttribute('src')).toBe('https://art.test/next.jpg');
    expect(container.querySelector('.np__upcoming')?.textContent).toMatch(/Up next|Loading next/);
    const [a,b]=decks() as [HTMLAudioElement,HTMLAudioElement];a.currentTime=12;
    await act(async()=>{a.dispatchEvent(new Event('timeupdate'));});
    b.currentTime=29;
    await act(async()=>{b.dispatchEvent(new Event('timeupdate'));b.dispatchEvent(new Event('waiting'));});
    expect((container.querySelector('.prog input') as HTMLInputElement).value).toBe('12');
    rerender(createElement(Player,{...props,docked,playing:current,upNext:[{...upcoming[0]!,title:'Different upcoming title'}]}));
    await settle();
    expect(container.querySelector('.np__main .np__title')?.textContent).toBe('Song one');
    expect(container.querySelector('.np__main img')?.getAttribute('src')).toBe('https://art.test/current.jpg');
    expect(container.querySelector('.np__upcoming')?.textContent).toContain('Different upcoming title');
  });
});
