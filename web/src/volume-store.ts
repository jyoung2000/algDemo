/**
 * VOLUME-SETTINGS-001 (owner, 2026-11-22): "move the volume control for the app to the top of settings instead of in the
 * player control". The app's one volume level. It lived inside the song player (and a second, unsaved level inside
 * the radio player); now the control is in Settings, so the level is held here and whichever player is sounding
 * follows it. Remembered on the device under the key the song player always used.
 */
import { VOLUME_MAX, readVolume } from './engine/volume-boost';

const KEY = 'airwave.volume';
type Listener = () => void;

function load(): { value: number; muted: boolean } {
  try { return readVolume(window.localStorage.getItem(KEY)); } catch { return { value: 0.8, muted: false }; }
}
let state = load();
/** The last level that made a sound: what unmuting from a slider at zero returns to. */
let last = state.value > 0 ? state.value : 0.5;
let top = VOLUME_MAX;
let why = '';
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());
const clamp = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(VOLUME_MAX, v)) : 0);

function put(next: { value: number; muted: boolean }): void {
  if (next.value === state.value && next.muted === state.muted) return;
  state = next;
  if (state.value > 0) last = state.value;
  try { window.localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode: the volume just is not remembered */ }
  emit();
}

export const volumeStore = {
  subscribe(l: Listener): () => void { listeners.add(l); return () => listeners.delete(l); },
  /** 0 to 2 (200%), whether or not it is muted. */
  level: (): number => state.value,
  muted: (): boolean => state.muted,
  /** What should be heard: 0 while muted. */
  audible: (): number => (state.muted ? 0 : state.value),
  /** Moving the level unmutes, as dragging the slider always did. */
  set(v: number): void { put({ value: clamp(v), muted: false }); },
  toggleMute(): void {
    if (!state.muted && state.value > 0) put({ value: state.value, muted: true });
    else put({ value: state.value > 0 ? state.value : last > 0 ? last : 0.5, muted: false });
  },
  /** How high the playing source can go (1, or 2 where it can boost), and why it cannot be changed ('' when it can). */
  max: (): number => top,
  blocked: (): string => why,
  setLimits(max: number, blocked: string): void {
    const m = max > 1 ? VOLUME_MAX : 1;
    if (m === top && blocked === why) return;
    top = m; why = blocked;
    emit();
  },
};
