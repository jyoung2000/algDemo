// PLAYER-TRUTH-001: the player shows the song that is actually sounding.
import { describe, expect, it } from 'vitest';
import { heldOverKey } from './player-truth';

const st = (o: Partial<Parameters<typeof heldOverKey>[0] & object> = {}) => ({ id: 'new', playWhenReady: true, sounding: 'old', soundingPlaying: true, ...o });

describe('which song the player shows while a chosen song loads', () => {
  it('keeps the song still sounding while the chosen one is not loaded yet', () => {
    expect(heldOverKey(st(), 'new', 'old')).toBe('old');
  });
  it('keeps it while the listener has paused it', () => {
    expect(heldOverKey(st({ soundingPlaying: false, playWhenReady: false }), 'new', 'old')).toBe('old');
  });
  it('lets the chosen song take over once it sounds', () => {
    expect(heldOverKey(st({ sounding: 'new' }), 'new', 'old')).toBeNull();
  });
  it('lets the chosen song take over when the old one has ended (stopped, still wanting to play)', () => {
    expect(heldOverKey(st({ soundingPlaying: false, playWhenReady: true }), 'new', 'old')).toBeNull();
  });
  it('nothing to hold: nothing sounding, an engine that does not report it, or a different song sounding', () => {
    expect(heldOverKey(st({ sounding: null }), 'new', 'old')).toBeNull();
    expect(heldOverKey({ id: 'new', playWhenReady: true }, 'new', 'old')).toBeNull();
    expect(heldOverKey(st({ sounding: 'other' }), 'new', 'old')).toBeNull();
  });
  it('only about the song this page chose', () => {
    expect(heldOverKey(st({ id: 'elsewhere' }), 'new', 'old')).toBeNull();
    expect(heldOverKey(st(), 'new', null)).toBeNull();
    expect(heldOverKey(null, 'new', 'old')).toBeNull();
  });
});
