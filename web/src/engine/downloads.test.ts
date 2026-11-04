// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { playbackActive } from './downloads';

describe('native playback state', () => {
  afterEach(() => { delete (window as unknown as { AirwaveNative?: unknown }).AirwaveNative; });

  it('reports the deck state and song title to the Android notification bridge', () => {
    const playbackState = vi.fn();
    (window as unknown as { AirwaveNative: unknown }).AirwaveNative = { playbackState };
    playbackActive(true, 'Local full song');
    expect(playbackState).toHaveBeenCalledWith('{"playing":true,"title":"Local full song"}');
    playbackActive(false);
    expect(playbackState).toHaveBeenCalledWith('{"playing":false,"title":"Airwave Discovery"}');
  });

  it('sends playing state and title to the Android bridge, falling back to Windows', async () => {
    const { playbackActive } = await import('./downloads');
    const playbackState = vi.fn();
    const playback = vi.fn();
    (window as unknown as { AirwaveNative: unknown }).AirwaveNative = { playbackState, playback };
    playbackActive(true, 'Carefree');
    expect(playbackState).toHaveBeenCalledWith('{"playing":true,"title":"Carefree"}');
    expect(playback).not.toHaveBeenCalled();
    (window as unknown as { AirwaveNative: unknown }).AirwaveNative = { playback };
    playbackActive(false);
    expect(playback).toHaveBeenCalledWith(false);
  });

  it('reports playing state to the Windows suspension blocker', () => {
    const playback = vi.fn();
    (window as unknown as { AirwaveNative: unknown }).AirwaveNative = { playback };
    playbackActive(true);
    playbackActive(false);
    expect(playback.mock.calls).toEqual([[true], [false]]);
  });
});
