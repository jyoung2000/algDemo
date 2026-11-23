/**
 * CAR-KEEP-001 (owner: "when I turn off and on my car the app disappears"): what the phone says
 * about how jPlay was installed, for the Settings "Android Auto" card (CarKeep.tsx).
 *
 * The Android bridge answers `AirwaveNative.carInstall()` with JSON built by CarInstall.kt. The
 * method is absent on Windows, in a browser and in older APKs: there the reader returns null and
 * the card renders nothing. Bad or unexpected JSON is also null; this never throws.
 */

/** PLAY: Google Play installed it. PLAY_NAME_ONLY: only the installer name says so. */
export type CarVerdict = 'PLAY' | 'PLAY_NAME_ONLY' | 'SIDELOADED';

export interface CarInstallInfo {
  verdict: CarVerdict;
  /** The installer package name the phone recorded, e.g. com.android.vending. */
  installer: string | null;
  /** The package that started the install (Android 11+), e.g. com.android.shell for adb. */
  initiating: string | null;
  originating: string | null;
  androidAuto: { installed: boolean; version: string | null };
  /** The phone's Android API level; 0 when the bridge did not say. */
  sdk: number;
}

interface CarNative {
  carInstall?: () => unknown;
  openCarSettings?: () => unknown;
}

const VERDICTS: readonly CarVerdict[] = ['PLAY', 'PLAY_NAME_ONLY', 'SIDELOADED'];

const native = (): CarNative | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as { AirwaveNative?: CarNative }).AirwaveNative;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** How jPlay was installed, or null when this shell cannot say. */
export function carInstall(): CarInstallInfo | null {
  try {
    const n = native();
    if (typeof n?.carInstall !== 'function') return null;
    // Called on the bridge object: an Android bridge method fails when detached from it.
    const raw = n.carInstall();
    if (typeof raw !== 'string') return null;
    const o = JSON.parse(raw) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') return null;
    const verdict = VERDICTS.find((v) => v === o.verdict);
    if (!verdict) return null;
    const auto = (o.androidAuto && typeof o.androidAuto === 'object' ? o.androidAuto : {}) as Record<string, unknown>;
    const installed = auto.installed === true;
    return {
      verdict,
      installer: text(o.installer),
      initiating: text(o.initiating),
      originating: text(o.originating),
      androidAuto: { installed, version: installed ? text(auto.version) : null },
      sdk: typeof o.sdk === 'number' && Number.isFinite(o.sdk) ? o.sdk : 0,
    };
  } catch {
    return null;
  }
}

/** Ask the phone to open Android Auto's settings. False when it could not, or cannot be asked. */
export function openCarSettings(): boolean {
  try {
    const n = native();
    if (typeof n?.openCarSettings !== 'function') return false;
    return n.openCarSettings() === true;
  } catch {
    return false;
  }
}
