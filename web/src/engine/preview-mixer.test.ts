import { describe, expect, it, vi } from 'vitest';
import { PreviewMixer } from './preview-mixer';
import type { AudioBus } from './audio-bus';

function setup() {
  const media = () => ({ src: '', currentTime: 0, duration: 30, readyState: 4, paused: true, ended: false, seeking: false,
    playbackRate: 1, preservesPitch: true,
    play: vi.fn(async function (this: { paused: boolean }) { this.paused = false; }),
    pause: vi.fn(function (this: { paused: boolean }) { this.paused = true; }),
    load: vi.fn(), removeAttribute: vi.fn(),
  });
  const a = media(), b = media();
  a.src = 'out.wav'; a.paused = false;
  const bus = { cut: vi.fn(), transitionTo: vi.fn() };
  const resolve = vi.fn(async (url: string) => url);
  const status = vi.fn();
  const m = new PreviewMixer({ a: a as unknown as HTMLAudioElement, b: b as unknown as HTMLAudioElement },
    () => bus as unknown as AudioBus, resolve, status);
  return { m, a, b, bus, resolve, status };
}
const next = { key: 'b', preview: 'b.wav' };

describe('preview crossfader lifecycle', () => {
  it('preloads the next song without starting it, then overlaps at the planned point', async () => {
    const { m, a, b, bus } = setup();
    await m.prepare(next);
    expect(b.src).toBe('b.wav'); expect(b.play).not.toHaveBeenCalled();
    a.currentTime = 28; await m.tick(100);
    expect(b.play).not.toHaveBeenCalled();
    a.currentTime = 28.6; await m.tick(100);
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(bus.transitionTo).toHaveBeenCalledWith('b', expect.closeTo(1.4, 5), 'filter'); // the 5% tail of a 30s deck
    expect(a.paused).toBe(false); expect(b.paused).toBe(false);
  });
  it('starts the blend where the play-through setting says, not at a fixed 95% (MIXER-PLAY-THROUGH-002)', async () => {
    const { m, a, b, bus } = setup(); await m.prepare(next);
    a.currentTime = 23; await m.tick(100, 0.8); // 80% of 30 s = 24 s: not yet
    expect(b.play).not.toHaveBeenCalled();
    a.currentTime = 24.1; await m.tick(100, 0.8);
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(bus.transitionTo).toHaveBeenCalledWith('b', expect.closeTo(5.9, 5), 'filter');
  });

  it('does nothing at Off, during repeat/pause/seek, or with an unready next song', async () => {
    const { m, a, b, bus } = setup(); await m.prepare(next); a.currentTime = 29;
    await m.tick(0); a.paused = true; await m.tick(100);
    a.paused = false; a.seeking = true; await m.tick(100);
    a.seeking = false; b.readyState = 1; await m.tick(100);
    expect(bus.transitionTo).not.toHaveBeenCalled();
  });
  it('promotes exactly the preloaded song without restarting it', async () => {
    const { m, a, b, bus } = setup(); await m.prepare(next); a.currentTime = 28.6; await m.tick(100);
    b.currentTime = 12;
    expect(m.finish()).toEqual({ key: 'b', deck: 'b' });
    expect(m.active).toBe('b'); expect(a.paused).toBe(true);
    expect(b.currentTime).toBe(12); expect(b.play).toHaveBeenCalledTimes(1);
    expect(bus.cut).toHaveBeenLastCalledWith('b');
    expect(m.finish()).toBeNull();
  });
  it('works A→B→A, not just for the first pair', async () => {
    const { m, a, b, bus } = setup(); await m.prepare(next); a.currentTime = 28.6; await m.tick(100); m.finish();
    await m.prepare({ key: 'c', preview: 'c.wav' });
    expect(a.src).toBe('c.wav'); b.currentTime = 28.6; await m.tick(100);
    expect(bus.transitionTo).toHaveBeenLastCalledWith('a', expect.closeTo(1.4, 5), 'filter');
    expect(m.finish()).toEqual({ key: 'c', deck: 'a' });
  });
  it('ignores a late URL from an obsolete queue item', async () => {
    const { m, b, resolve } = setup(); let finish!: (s: string) => void;
    resolve.mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const old = m.prepare(next);
    await m.prepare({ key: 'c', preview: 'c.wav' }); finish('obsolete.wav'); await old;
    expect(b.src).toBe('c.wav');
  });
  it('cancels safely while play() is pending; a late success cannot fade the new song', async () => {
    const { m, a, b, bus } = setup(); await m.prepare(next); a.currentTime = 28.6;
    let finish!: () => void; b.play.mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const pending = m.tick(100); m.cancel(); finish(); await pending;
    expect(bus.transitionTo).not.toHaveBeenCalled(); expect(b.paused).toBe(true);
  });
  it('cancels an overlap on seek/skip/Off and restores only the current track', async () => {
    const { m, a, b, bus } = setup(); await m.prepare(next); a.currentTime = 28.6; await m.tick(100);
    m.cancel(); expect(b.paused).toBe(true); expect(bus.cut).toHaveBeenLastCalledWith('a');
    expect(m.finish()).toBeNull();
  });
  it('never advances early when the incoming play promise rejects', async () => {
    const { m, a, b, bus, status } = setup(); await m.prepare(next); a.currentTime = 28.6;
    b.play.mockRejectedValueOnce(new Error('not allowed')); await m.tick(100); await m.tick(100);
    expect(bus.transitionTo).not.toHaveBeenCalled(); expect(m.finish()).toBeNull();
    expect(a.paused).toBe(false); expect(status).toHaveBeenLastCalledWith(expect.stringContaining('could not start'));
  });
  it('does not promote a stalled or failed incoming deck', async () => {
    const { m, a, b } = setup(); await m.prepare(next); a.currentTime = 28.6; await m.tick(100);
    b.paused = true; expect(m.finish()).toBeNull(); expect(m.active).toBe('a');
  });
  it('uses actual remaining time after a slow play promise, not a fade past EOF', async () => {
    const { m, a, b, bus } = setup(); await m.prepare(next); a.currentTime = 28.6;
    b.play.mockImplementationOnce(async () => { a.currentTime = 25; b.paused = false; });
    await m.tick(100); expect(bus.transitionTo).toHaveBeenCalledWith('b', expect.closeTo(1.5, 5), 'filter'); // the plan's 1.5s, not the 5s now left
  });
  it('does not re-fetch a stable lookahead on a volume render', async () => {
    const { m, resolve } = setup(); await m.prepare(next); await m.prepare({ ...next });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
