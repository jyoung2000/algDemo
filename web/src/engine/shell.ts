/** Which shell the web bundle is running inside. The browser has no native downloader at all. */
export type ShellPlatform = 'android' | 'windows' | 'browser';

interface NativeWindow { AirwaveNative?: { downloads?: unknown } }

/**
 * Both shells expose the same `AirwaveNative` bridge, so the bridge alone cannot tell them apart;
 * the user agent is the discriminator. Verified against MainActivity.kt
 * (`addJavascriptInterface(Bridge(this), "AirwaveNative")`) and windows/preload.cjs
 * (`exposeInMainWorld('AirwaveNative', …)`).
 */
export function shellPlatform(): ShellPlatform {
  const native = (globalThis as unknown as NativeWindow).AirwaveNative;
  const android = /android/i.test(navigator.userAgent ?? '');
  if (typeof native?.downloads !== 'function') return android ? 'android' : 'browser';
  return android ? 'android' : 'windows';
}
