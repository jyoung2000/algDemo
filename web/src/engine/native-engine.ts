/**
 * The Android app's native audio engine, seen from the page (plan ruling 2026-11-08, Task 2).
 *
 * Inside the Android app the service plays every song, through ports of this app's own EQ,
 * crossfade and mixer, so music carries on with the screen off and after the app is closed, and
 * the lock screen, Bluetooth and Android Auto control the same playback. The page stays in charge of
 * WHAT plays while it is open — it chooses (`load`) and says what comes next (`cue`) — and mirrors
 * WHERE playback is from the state the engine reports. Nothing here plays sound itself.
 *
 * Elsewhere (the Windows app, a browser) `engineAvailable()` is false and none of this runs.
 */
import { COMPLETE_S, SKIP_MAX_S, SKIP_MIN_S, qualifiesCompletion } from '../util';
import { songFromTrack, type NativeSong } from './media-native';
import type { Track } from '../api';

/** A song as the engine needs it (`songFromTrack`). `source` is the download link of the complete local file. */
export type EngineSong = NativeSong;

/**
 * The song as the engine is told about it. Unlike the car's library entry it carries its download
 * link even before the file is here: the engine waits on that link and starts the song the moment
 * the file lands, with no help from this page. The link only ever names a file the app downloaded.
 */
export function engineSong(track: Track, ready: boolean, link: string | null): EngineSong {
  return { ...songFromTrack(track, ready, link), source: link };
}

/** Something the engine did by itself, with how much of the song it left was heard. */
export interface EngineEvent {
  seq: number;
  /** 'end' (played out), 'blend' (the mixer blended into the next), 'repeat' (repeat-one looped),
   *  'next' / 'prev' (a control pressed while the page was not open). */
  cause: 'end' | 'blend' | 'repeat' | 'next' | 'prev';
  /** False when the song ended and nothing followed (the end of the list, or waiting for the page). */
  advanced: boolean;
  from: { id: string; heardMs: number; durationMs: number };
}

export interface EngineState {
  /** Bumped by every change of song the engine made itself; sent back with `load`. */
  rev: number;
  id: string | null;
  mediaId: string | null;
  playing: boolean;
  playWhenReady: boolean;
  buffering: boolean;
  /** The chosen song's file is not on the phone yet; it starts when it is. */
  waiting: boolean;
  /** STREAM-DL-001: the engine plays this song from its source while the file downloads. */
  streaming?: boolean;
  ended: boolean;
  error: string | null;
  positionMs: number;
  durationMs: number;
  blending: string | null;
  event?: EngineEvent;
  /** After `hello`: what the engine did while the page was away, oldest first. */
  pending?: EngineEvent[];
}

type Bridge = { engine?: (json: string) => void };
const bridge = (): Bridge | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as { AirwaveNative?: Bridge }).AirwaveNative;

/** True only inside the Android app, whose service owns playback. */
export const engineAvailable = (): boolean => typeof bridge()?.engine === 'function';

type Command =
  | { op: 'load'; song: EngineSong; mediaId?: string | null; positionMs: number; play: boolean; rev: number }
  | { op: 'cue'; song: EngineSong | null }
  | { op: 'play' }
  | { op: 'pause' }
  | { op: 'seek'; positionMs: number }
  | { op: 'settings'; eq?: unknown; mix?: number; playThrough?: number; volume?: number }
  | { op: 'ack'; seq: number }
  | { op: 'hello' };

export function engineSend(cmd: Command): void {
  const b = bridge();
  if (typeof b?.engine !== 'function') return;
  try {
    b.engine(JSON.stringify(cmd));
  } catch {
    /* a closed bridge or an unserialisable value: drop the command rather than break the page */
  }
}

let latest: EngineState | null = null;
const listeners = new Set<(s: EngineState) => void>();

/** The engine's last reported state (null until it has reported). */
export const engineState = (): EngineState | null => latest;

/** The newest `rev` the page has seen; a `load` carries it so the engine can drop a stale one. */
export const engineRev = (): number => latest?.rev ?? 0;

export function subscribeEngineState(fn: (s: EngineState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The native side calls `window.__awEngine(json)`. Installed on import. */
export function installEngineHook(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { __awEngine?: (json: string) => void }).__awEngine = (json: string) => {
    let s: EngineState;
    try {
      s = JSON.parse(json) as EngineState;
    } catch {
      return;
    }
    if (!s || typeof s !== 'object' || typeof s.rev !== 'number') return;
    latest = s;
    for (const l of [...listeners]) l(s);
  };
}
installEngineHook();

/** For tests: forget the last state and every listener. */
export function resetEngineForTests(): void {
  latest = null;
  listeners.clear();
  handled.clear();
}

/**
 * Claim an engine event for handling and acknowledge it, so the engine forgets it. Returns false
 * when it was already handled: a live event and the same one listed again in `pending` after the
 * app returns must be counted once.
 */
const handled = new Set<number>();
export function markEngineEvent(seq: number): boolean {
  if (handled.has(seq)) return false;
  handled.add(seq);
  if (handled.size > 512) handled.delete(handled.values().next().value as number);
  engineSend({ op: 'ack', seq });
  return true;
}

/**
 * What a song the engine played while the page was away teaches, by the same rules the player
 * applies to a song it watched: a completion needs COMPLETE_S of listening and enough of the song
 * (qualifiesCompletion); a Next press after SKIP_MIN_S..SKIP_MAX_S is a skip. The engine counts
 * every frame it rendered, so `heardMs` is time listened (a rewind is counted again); coverage is
 * capped at the song's length.
 */
export function listenFromEvent(ev: EngineEvent): { kind: 'complete' | 'skip'; listened: number; coverage: number; duration: number | null } | null {
  const listened = Math.max(0, ev.from.heardMs) / 1000;
  const duration = ev.from.durationMs > 0 ? Math.round(ev.from.durationMs / 1000) : null;
  const coverage = duration !== null ? Math.min(listened, ev.from.durationMs / 1000) : listened;
  if (ev.cause === 'end' || ev.cause === 'blend' || ev.cause === 'repeat') {
    return listened >= COMPLETE_S && qualifiesCompletion('full', coverage, duration) ? { kind: 'complete', listened, coverage, duration } : null;
  }
  if (ev.cause === 'next' && listened >= SKIP_MIN_S && listened < SKIP_MAX_S) return { kind: 'skip', listened, coverage, duration };
  return null;
}
