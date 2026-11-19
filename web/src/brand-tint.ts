import type { Characteristics } from './api';
import { pickerColorFor } from './util';

/**
 * JPLAY-BRAND-001 (owner, 2026-11-19: "it would be cool if the logo or icon changed colors based on the
 * users current listening mood color"). The mood's colour is the Taste Picker colour of the genre
 * leading the listening mood (MOOD-QUEUE-001's `leading`). With too little listening behind the mood,
 * or a leading genre the picker has no colour for, the song playing gives the colour; with neither,
 * null (the logo keeps its own grey).
 */
export const MOOD_TINT_MIN_CONFIDENCE = 0.15;

export interface MoodLead {
  leading: string[];
  confidence: number;
}

export function moodTint(mood: MoodLead | null | undefined, playing: Characteristics | null | undefined): string | null {
  if (mood && mood.confidence >= MOOD_TINT_MIN_CONFIDENCE) {
    for (const g of mood.leading.slice(0, 1)) {
      const c = pickerColorFor(g);
      if (c) return c;
    }
  }
  return playing?.color ?? playing?.families?.[0]?.color ?? null;
}
