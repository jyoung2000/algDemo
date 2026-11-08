// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  engineAvailable,
  engineRev,
  engineSend,
  engineState,
  listenFromEvent,
  markEngineEvent,
  resetEngineForTests,
  subscribeEngineState,
  type EngineEvent,
} from './native-engine';

type Win = { AirwaveNative?: { engine?: (json: string) => void }; __awEngine?: (json: string) => void };
const win = () => window as unknown as Win;

const state = (over: Record<string, unknown> = {}) => ({
  rev: 0, id: 'a', mediaId: 'a', playing: true, playWhenReady: true, buffering: false, waiting: false,
  ended: false, error: null, positionMs: 1000, durationMs: 200000, blending: null, ...over,
});

const event = (cause: EngineEvent['cause'], heardMs: number, durationMs = 200000, seq = 1): EngineEvent =>
  ({ seq, cause, advanced: true, from: { id: 'a', heardMs, durationMs } });

describe('native engine bridge (Android)', () => {
  let sent: string[];
  beforeEach(() => {
    sent = [];
    win().AirwaveNative = { engine: (json) => void sent.push(json) };
  });
  afterEach(() => {
    delete win().AirwaveNative;
    resetEngineForTests();
  });

  it('is available only where the Android app provides the engine', () => {
    expect(engineAvailable()).toBe(true);
    delete win().AirwaveNative;
    expect(engineAvailable()).toBe(false);
    engineSend({ op: 'play' }); // nowhere to send: dropped, no throw
    expect(sent).toHaveLength(0);
  });

  it('sends one JSON command per call', () => {
    engineSend({ op: 'seek', positionMs: 1234 });
    expect(JSON.parse(sent[0]!)).toEqual({ op: 'seek', positionMs: 1234 });
  });

  it('mirrors what the engine reports and keeps the newest rev for the next load', () => {
    const seen: number[] = [];
    subscribeEngineState((s) => seen.push(s.positionMs));
    win().__awEngine!(JSON.stringify(state({ rev: 3, positionMs: 4200 })));
    expect(seen).toEqual([4200]);
    expect(engineState()?.id).toBe('a');
    expect(engineRev()).toBe(3);
  });

  it('ignores a malformed report rather than breaking the page', () => {
    const seen = vi.fn();
    subscribeEngineState(seen);
    win().__awEngine!('{not json');
    win().__awEngine!(JSON.stringify({ id: 'a' })); // no rev
    expect(seen).not.toHaveBeenCalled();
    expect(engineState()).toBeNull();
  });

  it('counts an event once, live or listed again after the app returns, and acknowledges it', () => {
    expect(markEngineEvent(7)).toBe(true);
    expect(markEngineEvent(7)).toBe(false);
    expect(sent.map((j) => JSON.parse(j))).toEqual([{ op: 'ack', seq: 7 }]);
  });
});

describe('what a song the engine played teaches', () => {
  it('a song heard to the end is a completion, by the same rule as a watched song', () => {
    expect(listenFromEvent(event('end', 200000))).toMatchObject({ kind: 'complete', listened: 200, coverage: 200, duration: 200 });
    expect(listenFromEvent(event('blend', 150000))).toMatchObject({ kind: 'complete' });
    expect(listenFromEvent(event('repeat', 200000))).toMatchObject({ kind: 'complete' });
  });

  it('too little of the song is not a completion', () => {
    // 70% of 200 s is the bar; 30 s of a 200 s song after a seek to near the end is not a listen.
    expect(listenFromEvent(event('end', 30000))).toBeNull();
    expect(listenFromEvent(event('end', 19000, 25000))).toBeNull();
  });

  it('a Next press after a few seconds is a skip; a very early or a late one is not', () => {
    expect(listenFromEvent(event('next', 5000))).toMatchObject({ kind: 'skip', listened: 5 });
    expect(listenFromEvent(event('next', 1000))).toBeNull();
    expect(listenFromEvent(event('next', 60000))).toBeNull();
    expect(listenFromEvent(event('prev', 5000))).toBeNull();
  });

  it('coverage never exceeds the song, even when a rewind was heard twice', () => {
    expect(listenFromEvent(event('end', 260000))).toMatchObject({ listened: 260, coverage: 200 });
  });
});
