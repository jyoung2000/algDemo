/**
 * The Windows app is Electron, whose user agent carries the app name and version: "jPlay/0.20.0"
 * since the rename (JPLAY-BRAND-002), "AirwaveDiscovery/x.y" before it.
 */
export function isDesktopShell(userAgent: string): boolean {
  return /\b(?:jPlay|AirwaveDiscovery)\/\d/.test(userAgent) && /\bElectron\//.test(userAgent);
}
