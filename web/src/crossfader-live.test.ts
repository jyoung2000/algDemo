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
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Player, type Playing, type UpNext } from './Player';
import { PREVIEW_ROUTE } from './engine/shape';
import { resetEngineForTests, setMixSlider } from './audio-engine';

const lookedUp: string[] = [];
vi.mock('./api', () => ({
  api: {
    previewUrl: (route: string) => Promise.resolve({ url: `https://cdn.test/${route.split('/').pop()}.mp3` }),
    // The player looks for a full YouTube version of every song; these cases are about previews,
    // so the lookup answers "none found" and the preview path is the one under test.
    fullSong: (t: { key: string }) => {
      lookedUp.push(t.key);
      return Promise.resolve({ id: null, confident: false });
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
const upNext = (key: string): UpNext[] => [{ key, title: `Song ${key}`, artist: 'A', artwork: null, preview: route(key) }];

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
  ramps.length = 0; sourced.clear();
  lookedUp.length = 0;
  stubMedia();
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  resetEngineForTests();
  setMixSlider(0);
});
afterEach(() => { cleanup(); resetEngineForTests(); vi.unstubAllGlobals(); });

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

  it('overlaps the two songs and fades between them at the planned point', async () => {
    setMixSlider(100);
    render(createElement(Player, { ...props, playing: playing('one'), upNext: upNext('two') }));
    await settle();
    const [a, b] = decks() as [HTMLAudioElement, HTMLAudioElement];
    setPaused(a, false);

    // Early in the song nothing should start.
    a.currentTime = 4;
    await act(async () => { a.dispatchEvent(new Event('timeupdate')); });
    await settle();
    expect(b.paused).toBe(true);

    // 30s preview, 40% ceiling -> a 12s blend begins at 18s.
    a.currentTime = 19;
    await act(async () => { a.dispatchEvent(new Event('timeupdate')); });
    await settle();
    expect(b.src).toBe('https://cdn.test/two.mp3');
    expect(b.paused).toBe(false);
    expect(a.paused).toBe(false); // both audible at once: that is the blend
    const faded = ramps.filter((r) => r.param.includes('gain') && r.param.includes('curve'));
    expect(faded.length).toBeGreaterThanOrEqual(2); // one curve out, one in
  });

  it('says what it is doing, and only while it can actually do it', async () => {
    setMixSlider(100);
    const { container, rerender } = render(createElement(Player, { ...props, playing: playing('one'), upNext: upNext('two') }));
    await settle();
    expect(container.querySelector('.np__note--mix')?.textContent).toMatch(/Ready to blend|Preparing/);

    // A song in YouTube's own player cannot be blended; the line must not claim otherwise.
    rerender(createElement(Player, {
      ...props, upNext: upNext('two'),
      playing: {
        track: track('yt') as Playing['track'],
        playback: { kind: 'full', video_id: 'abc', preview: null, open: [], embed: null } as Playing['playback'],
      },
    }));
    await settle();
    expect(container.querySelector('.np__note--mix')).toBeNull();
  });

  it('plays the preview rather than the full song while the mixer is on, so it can mix at all', async () => {
    // Measured on the real app: every song in the list had a YouTube match, so every one played in
    // YouTube's iframe, where the mixer cannot reach the audio. Without this preference the
    // crossfader is a control that silently does nothing.
    const withVideo = (key: string): Playing => ({
      // knownVideoId reads the track's own provider, which is how a song arrives already knowing
      // its YouTube video — no lookup needed, so this is the strongest form of the conflict.
      track: { ...track(key), provider: 'ytmusic', platform_id: 'dQw4w9WgXcQ' } as Playing['track'],
      playback: { kind: 'full', preview: route(key), open: [], embed: null } as Playing['playback'],
    });

    // Mixer off: the full song wins and the iframe is used.
    const { container, unmount } = render(createElement(Player, { ...props, playing: withVideo('one'), upNext: upNext('two') }));
    await settle();
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(decks().some((d) => d.getAttribute('src'))).toBe(false);
    unmount();

    // Mixer on: the same song plays as its preview, on a deck, with no iframe.
    setMixSlider(70);
    const second = render(createElement(Player, { ...props, playing: withVideo('one'), upNext: upNext('two') }));
    await settle();
    expect(second.container.querySelector('iframe')).toBeNull();
    expect(decks()[0]?.getAttribute('src')).toBe('https://cdn.test/one.mp3');
    // And it never asks YouTube about a song it has already decided to play as a preview.
    expect(lookedUp).not.toContain('one');
  });

  it('leaves the blended-in song playing instead of restarting it', async () => {
    setMixSlider(100);
    const onNext = vi.fn();
    const { rerender } = render(createElement(Player, { ...props, onNext, playing: playing('one'), upNext: upNext('two') }));
    await settle();
    const [a, b] = decks() as [HTMLAudioElement, HTMLAudioElement];
    setPaused(a, false);
    a.currentTime = 19;
    await act(async () => { a.dispatchEvent(new Event('timeupdate')); });
    await settle();
    b.currentTime = 11;
    const playsBefore = (b.play as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    await act(async () => { a.dispatchEvent(new Event('ended')); });
    await settle();
    expect(onNext).toHaveBeenCalledTimes(1);

    // App now reports the next song as current. The element must keep its playhead.
    rerender(createElement(Player, { ...props, onNext, playing: playing('two'), upNext: [] }));
    await settle();
    expect(b.currentTime).toBe(11);
    expect((b.play as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(playsBefore);
    expect(b.paused).toBe(false);
    // The regression this locks down: the blended-in song used to be looked up on YouTube like any
    // new song, and while that lookup ran its source counted as unresolved — so the load effect
    // paused the deck and stripped its src, killing the song the blend had just handed over.
    expect(lookedUp).not.toContain('two');
    expect(b.getAttribute('src')).toBe('https://cdn.test/two.mp3');
  });

  it('drops a blend when the listener seeks, leaving only the current song', async () => {
    setMixSlider(100);
    const { container } = render(createElement(Player, { ...props, playing: playing('one'), upNext: upNext('two') }));
    await settle();
    const [a, b] = decks() as [HTMLAudioElement, HTMLAudioElement];
    setPaused(a, false);
    a.currentTime = 19;
    await act(async () => { a.dispatchEvent(new Event('timeupdate')); });
    await settle();
    expect(b.paused).toBe(false);

    // fireEvent.change, not a raw 'input' event: React tracks a controlled input's last value and
    // drops an event whose value it believes it already has.
    const slider = container.querySelector('.prog input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(slider, { target: { value: '5' } });
    });
    await settle();
    expect(b.paused).toBe(true);
    expect(a.paused).toBe(false);
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
    a.currentTime = 19;
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
    a.currentTime = 19;
    await act(async () => { a.dispatchEvent(new Event('timeupdate')); });
    await settle();
    expect(b.paused).toBe(true);
    expect(ramps.filter((r) => r.param.includes('curve'))).toHaveLength(0);
  });

});
