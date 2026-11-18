import { describe, expect, it, vi } from 'vitest';
import { PreviewMixer, entranceSeconds } from './preview-mixer';
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

describe('post-completion transition lifecycle', () => {
  it('preloads quietly and identifies the resolved full song rather than its catalogue locator', async () => {
    const {m,a,b,resolve,status}=setup();resolve.mockResolvedValueOnce('blob:full-song');
    await m.prepare({key:'b',preview:'/api/preview/deezer/1'});
    expect(b.src).toBe('blob:full-song');expect(b.play).not.toHaveBeenCalled();expect(a.paused).toBe(false);
    expect(status).toHaveBeenLastCalledWith('Ready for the next full song — after 100% of this song.');
  });
  it('ignores stale URL resolution and cannot replace a newer candidate', async()=>{
    const {m,b,resolve}=setup();let complete!:(v:string)=>void;
    resolve.mockImplementationOnce(()=>new Promise(r=>{complete=r}));
    const old=m.prepare(next);await m.prepare({key:'c',preview:'c.wav'});complete('obsolete.wav');await old;
    expect(b.src).toBe('c.wav');
  });
  it('cancels an in-flight play without advancing, and a late success cannot fade the new track',async()=>{
    const {m,a,b,bus}=setup();await m.prepare(next);a.ended=true;
    let complete!:()=>void;b.play.mockImplementationOnce(()=>new Promise(r=>{complete=r}));
    const handoff=m.handoff(80);m.cancel();complete();expect(await handoff).toBeNull();
    expect(m.active).toBe('a');expect(bus.transitionTo).not.toHaveBeenCalled();expect(b.paused).toBe(true);
  });
  it('leaves primary untouched when incoming playback rejects',async()=>{
    const {m,a,b,bus,status}=setup();await m.prepare(next);a.ended=true;b.play.mockRejectedValueOnce(new Error('blocked'));
    expect(await m.handoff(100)).toBeNull();expect(m.active).toBe('a');expect(bus.transitionTo).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith('Next song could not start.');
  });
  it('works A→B→A without replaying either ending or skipping either entrance',async()=>{
    const {m,a,b}=setup();await m.prepare(next);a.ended=true;await m.handoff(60);
    await m.prepare({key:'c',preview:'c.wav'});a.ended=false;b.ended=true;
    expect(await m.handoff(60)).toEqual({key:'c',deck:'a'});expect(m.active).toBe('a');expect(a.currentTime).toBe(0);
    expect(a.play).toHaveBeenCalledTimes(1);expect(b.play).toHaveBeenCalledTimes(1);
  });
  it('does not change master volume or pitch; fade length is capped for a full song entrance',()=>{
    expect(entranceSeconds(0,180)).toBe(0);expect(entranceSeconds(100,180)).toBe(2);
    expect(entranceSeconds(100,1)).toBe(0.1);expect(entranceSeconds(100,NaN)).toBe(2);
  });
  it('refuses Off, failed preparation and stale cancelled candidates',async()=>{
    const {m,a,b,resolve}=setup();a.ended=true;await m.prepare(next);
    expect(await m.handoff(0)).toBeNull();m.cancel();expect(await m.handoff(100)).toBeNull();
    resolve.mockRejectedValueOnce(new Error('missing'));await m.prepare(next);expect(await m.handoff(100)).toBeNull();
    expect(b.play).not.toHaveBeenCalled();
  });
});

describe('FULL-COMPLETION-001 hard end-of-source rule', () => {
  it('retains the prepared next source when seeking the current song',async()=>{
    const {m,a,b}=setup();await m.prepare(next);m.seeked();
    expect(b.src).toBe('b.wav');a.ended=true;expect(await m.handoff(100)).toEqual({key:'b',deck:'b'});
  });

  it('ignores old 95% settings and even the reported duration until the source actually ended', async () => {
    const { m, a, b, bus } = setup(); await m.prepare(next);
    for (const at of [28.6, 29.999, 30, 35]) {
      a.currentTime = at; await m.tick(100, 0.5);
      expect(b.play).not.toHaveBeenCalled();
      expect(bus.transitionTo).not.toHaveBeenCalled();
      expect(m.active).toBe('a');
    }
  });
  it('starts the next at zero only after ended, fades it in and promotes it immediately', async () => {
    const { m, a, b, bus } = setup(); await m.prepare(next);
    a.ended = true; a.paused = true; a.currentTime = 30;
    const result = await m.handoff(80);
    expect(result).toEqual({key: 'b', deck: 'b'});
    expect(b.currentTime).toBe(0); expect(b.playbackRate).toBe(1);
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(bus.transitionTo).toHaveBeenCalledWith('b', expect.any(Number), 'blend');
    expect(bus.transitionTo.mock.calls[0]![1]).toBeGreaterThan(0);
    expect(m.active).toBe('b');
    expect(await m.handoff(80)).toBeNull();
    // Preloading the following song must not cancel the fade-in now underway.
    bus.cut.mockClear(); await m.prepare({key:'c',preview:'c.wav'});
    expect(bus.cut).not.toHaveBeenCalled();
  });
  it('cannot hand over before ended even if a caller asks, or when the spare is unready', async () => {
    const { m, a, b } = setup(); await m.prepare(next);
    a.currentTime=30; expect(await m.handoff(100)).toBeNull();
    a.ended=true;b.readyState=1;expect(await m.handoff(100)).toBeNull();
    expect(b.play).not.toHaveBeenCalled();
  });
});
