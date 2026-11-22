// @vitest-environment happy-dom
// VOLUME-SETTINGS-001 (owner, 2026-11-22): "move the volume control for the app to the top of settings instead of in the
// player control". The level used to live inside the song player (and a second, unsaved one inside the radio player);
// with the control in Settings it is one level the whole app shares, remembered on the device.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'airwave.volume';
const fresh = async () => { vi.resetModules(); return (await import('./volume-store')).volumeStore; };
beforeEach(() => { window.localStorage.clear(); });

describe('the app\u2019s one volume level', () => {
  it('starts at 80%, or at what was saved, and keeps what is set', async () => {
    expect((await fresh()).level()).toBe(0.8);
    window.localStorage.setItem(KEY, JSON.stringify({ value: 1.5, muted: false }));
    const v = await fresh();
    expect(v.level()).toBe(1.5);
    v.set(0.4);
    expect(v.level()).toBe(0.4);
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ value: 0.4, muted: false });
    expect((await fresh()).level()).toBe(0.4);
  });

  it('tells its listeners once per change, and not when nothing changed', async () => {
    const v = await fresh();
    const heard = vi.fn();
    const off = v.subscribe(heard);
    v.set(0.5); v.set(0.5);
    expect(heard).toHaveBeenCalledTimes(1);
    off(); v.set(0.6);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('mutes and comes back to the level it had; moving the slider unmutes', async () => {
    const v = await fresh();
    v.set(0.7);
    v.toggleMute();
    expect(v.muted()).toBe(true);
    expect(v.audible()).toBe(0);
    expect(v.level()).toBe(0.7);
    v.toggleMute();
    expect(v.muted()).toBe(false);
    expect(v.audible()).toBe(0.7);
    v.toggleMute(); v.set(0.3);
    expect(v.muted()).toBe(false);
    // From a slider at zero, unmuting returns to the last level that made a sound.
    v.set(0.9); v.set(0); v.toggleMute();
    expect(v.level()).toBe(0.9);
  });

  it('never goes outside 0 to 200%, and ignores what is not a number', async () => {
    const v = await fresh();
    v.set(9); expect(v.level()).toBe(2);
    v.set(-1); expect(v.level()).toBe(0);
    v.set(Number.NaN); expect(v.level()).toBe(0);
  });

  it('carries what the player can do: how high it goes, and why it cannot be changed', async () => {
    const v = await fresh();
    expect(v.max()).toBe(2);
    expect(v.blocked()).toBe('');
    const heard = vi.fn();
    v.subscribe(heard);
    v.setLimits(1, 'SoundCloud\u2019s player has its own volume control.');
    expect(v.max()).toBe(1);
    expect(v.blocked()).toMatch(/SoundCloud/);
    expect(heard).toHaveBeenCalledTimes(1);
    v.setLimits(1, 'SoundCloud\u2019s player has its own volume control.');
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
