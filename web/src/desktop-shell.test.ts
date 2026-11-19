import { describe, expect, it } from 'vitest';
import { isDesktopShell } from './desktop-shell';

// JPLAY-BRAND-002: Electron puts the app name in its user agent, so the rename to jPlay changed it.
describe('isDesktopShell', () => {
  it('recognises the jPlay Windows app', () => {
    expect(isDesktopShell('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) jPlay/0.20.0 Chrome/152.0.7977.65 Electron/44.1.1 Safari/537.36')).toBe(true);
  });
  it('still recognises earlier builds', () => {
    expect(isDesktopShell('Mozilla/5.0 (Windows NT 10.0) AirwaveDiscovery/0.19.1 Chrome/150 Electron/43 Safari/537.36')).toBe(true);
  });
  it('is false for the Android app and browsers', () => {
    expect(isDesktopShell('Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/150 Mobile Safari/537.36')).toBe(false);
    expect(isDesktopShell('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150 Safari/537.36')).toBe(false);
  });
});
