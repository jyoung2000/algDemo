/**
 * CAR-SETTINGS-001 (owner, 2026-11-19): "On android auto add a button for settings to quickly change the algorithm and
 * eq presets". The car changes the EQ preset, the Familiar-Adventurous level or the listening-mood switch; the page
 * owns the stored settings, so it saves the choice and tells the engine it has it (the engine ignores older values a
 * waking page sends until that echo arrives). The phone's own changes go to the engine too, so the car's buttons read
 * what the phone set.
 */
import type { CarSettingsChange } from './media-native';
import type { EqConfig } from './eq';

export interface CarSettingsPorts {
  /** Save as the phone's own settings (PUT /api/settings). */
  save: (patch: CarSettingsChange) => Promise<unknown>;
  /** Tell the native engine. */
  send: (cmd: { op: 'settings'; eq?: EqConfig; adventurous?: number; mood_queue?: boolean }) => void;
}

/** Save the car's choice, then echo it to the engine so it stops guarding against an older value. */
export async function applyCarSettings(change: CarSettingsChange, ports: CarSettingsPorts): Promise<void> {
  await ports.save(change);
  ports.send({ op: 'settings', ...change });
}

/** The discovery settings the engine should know, from the phone's settings (null before they load). */
export function discoveryForEngine(s: { adventurous?: number; mood_queue?: boolean } | null | undefined): { op: 'settings'; adventurous: number; mood_queue: boolean } | null {
  if (!s) return null;
  const a = typeof s.adventurous === 'number' && Number.isFinite(s.adventurous) ? Math.min(1, Math.max(0, s.adventurous)) : 0.5;
  return { op: 'settings', adventurous: a, mood_queue: s.mood_queue !== false };
}
