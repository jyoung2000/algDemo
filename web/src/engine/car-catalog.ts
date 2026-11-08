import { api, type SearchResponse, type Track } from '../api';
import { songFromTrack, type NativeSong } from './media-native';

/** Bounded catalogue search for car queries. Search is metadata discovery, never automatic queue
 * insertion or proof of downloaded audio; selecting a retained Track uses the ordinary full-song
 * player/resolver. The native layer owns request IDs, timeout and result notifications. */
export class CarCatalog {
  private readonly tracks = new Map<string, Track>();
  private latest = '';
  constructor(
    private readonly lookup: (query: string) => Promise<SearchResponse> = api.search,
    private readonly ready: (track: Track) => boolean = () => false,
  ) {}
  find(id: string): Track | undefined { return this.tracks.get(id); }
  async search(raw: string): Promise<NativeSong[]> {
    const query = raw.trim().slice(0, 200);
    if (!query) return [];
    // Android Auto submits every edited prefix, not only Enter. Drop a query only when a longer
    // query extends it (still typing) — never when the car runs a genuinely different search in
    // parallel. Superseded calls resolve empty so the car never waits indefinitely.
    this.latest = query;
    await new Promise(resolve => setTimeout(resolve, 350));
    if (this.latest !== query && this.latest.startsWith(query)) return [];
    const result = await this.lookup(query);
    const states = Object.values(result.sources ?? {});
    if (!result.results.length && states.length && !states.some(s => s.state === 'ok')) {
      throw new Error('Music search is unavailable. Check your connection and try again.');
    }
    const rows = [...new Map(result.results.filter(t => t.key && t.title).map(t => [t.key, t])).values()].slice(0, 25);
    for (const track of rows) {
      this.tracks.delete(track.key);
      this.tracks.set(track.key, track);
    }
    while (this.tracks.size > 200) this.tracks.delete(this.tracks.keys().next().value!);
    return rows.map(t => songFromTrack(t, this.ready(t)));
  }
}
