import { urlAllowedFor } from './downloads';

/**
 * A hint, NOT a claim that the file still exists. The player/preloader must check the native local
 * library each time; an evicted file will never be offered as a ready song. Avoid asking the source
 * chain for 50+ Deezer songs again at every app launch just to rediscover links already downloaded.
 */
const KEY = 'airwave.ready-source.v1';
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;

export class ReadySourceMap {
  private readonly urls = new Map<string, string>();
  constructor(private readonly storage?: StoragePort) {
    try {
      const rows: unknown = JSON.parse(storage?.getItem(KEY) ?? '[]');
      if (Array.isArray(rows)) for (const entry of rows.slice(-500)) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') continue;
        if (entry[0].length <= 200 && urlAllowedFor('yt-dlp', entry[1])) this.urls.set(entry[0], entry[1]);
      }
    } catch { /* localStorage unavailable/private or older schema: restart empty */ }
  }
  get(trackKey: string): string | null { return this.urls.get(trackKey) ?? null; }
  remember(trackKey: string, url: string): void {
    if (!trackKey || trackKey.length > 200 || !urlAllowedFor('yt-dlp', url) || this.urls.get(trackKey) === url) return;
    this.urls.delete(trackKey);
    this.urls.set(trackKey, url);
    while (this.urls.size > 500) this.urls.delete(this.urls.keys().next().value!);
    try { this.storage?.setItem(KEY, JSON.stringify([...this.urls])); } catch { /* safe in private mode */ }
  }
}

/** Discovery-only suppressions survive a relaunch; expire after a day so fresh sources can be tried. */
export class DiscoveryExpiryMap {
  private readonly entries = new Map<string, number>();
  private static readonly KEY = 'airwave.discovery-expired.v1';
  private static readonly TTL = 24 * 60 * 60_000;
  constructor(private readonly storage?: StoragePort) {
    try {
      const rows: unknown = JSON.parse(storage?.getItem(DiscoveryExpiryMap.KEY) ?? '[]');
      const now = Date.now();
      if (Array.isArray(rows)) for (const row of rows.slice(-500)) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || row[0].length > 200 ||
            typeof row[1] !== 'number' || row[1] > now || now - row[1] >= DiscoveryExpiryMap.TTL) continue;
        this.entries.set(row[0], row[1]);
      }
    } catch { /* storage unavailable or invalid: no suppressions */ }
  }
  keys(): string[] { return [...this.entries.keys()]; }
  remember(key: string, expired: boolean): void {
    if (!key || key.length > 200) return;
    if (expired) this.entries.set(key, Date.now()); else this.entries.delete(key);
    while (this.entries.size > 500) this.entries.delete(this.entries.keys().next().value!);
    try { this.storage?.setItem(DiscoveryExpiryMap.KEY, JSON.stringify([...this.entries])); }
    catch { /* private mode must not break playback */ }
  }
}
