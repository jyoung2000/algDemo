import { api, type AlbumSearchResponse, type AlbumView, type IdentifyResponse, type SearchResponse, type Track } from '../api';
import { namesAlbum } from './album-key';
import { carAlbumTrackId, decodeCarAlbumId, songFromTrack, type CatalogAnswer, type NativeAlbum, type NativeSong } from './media-native';

/** ALBUM-CAR-001: how many albums a car search opens, and how many songs of each the car lists. */
const CAR_ALBUMS = 3;
const CAR_ALBUM_SONGS = 60;

/** Bounded catalogue search for car queries. Search is metadata discovery, never automatic queue
 * insertion or proof of downloaded audio; selecting a retained Track uses the ordinary full-song
 * player/resolver. The native layer owns request IDs, timeout and result notifications. */
export class CarCatalog {
  private readonly tracks = new Map<string, Track>();
  /** ALBUM-CAR-001: the albums a car search opened, by album id, songs in album order. */
  private readonly albumTracks = new Map<string, Track[]>();
  private latest = '';
  constructor(
    private readonly lookup: (query: string) => Promise<SearchResponse> = api.search,
    private readonly ready: (track: Track) => boolean = () => false,
    /** VOICE-SEARCH-001: the car asks for lyrics too, as the phone's search box does. */
    private readonly lyrics: ((query: string) => Promise<IdentifyResponse>) | null = null,
    /** ALBUM-CAR-001: the car asks for albums too, and opens the first few. */
    private readonly albums: ((query: string) => Promise<AlbumSearchResponse>) | null = null,
    private readonly openAlbum: ((id: string) => Promise<{ album: AlbumView }>) | null = null,
  ) {}
  find(id: string): Track | undefined { return this.tracks.get(id) ?? this.albumOf(id)?.track; }

  /** The song a car album id names, with the album it plays in; null for any other id. */
  albumOf(id: string): { track: Track; tracks: Track[] } | null {
    const ref = decodeCarAlbumId(id);
    const tracks = ref ? this.albumTracks.get(ref.albumId) : undefined;
    const track = tracks?.find((t) => t.key === ref!.key);
    return track && tracks ? { track, tracks } : null;
  }

  async search(raw: string): Promise<NativeSong[]> {
    return (await this.searchAll(raw)).songs;
  }

  async searchAll(raw: string, opts: { album?: boolean } = {}): Promise<Required<CatalogAnswer>> {
    const none = { songs: [], albums: [], play: null };
    const query = raw.trim().slice(0, 200);
    if (!query) return none;
    // Android Auto submits every edited prefix, not only Enter. Drop a query only when a longer
    // query extends it (still typing) — never when the car runs a genuinely different search in
    // parallel. Superseded calls resolve empty so the car never waits indefinitely.
    this.latest = query;
    await new Promise(resolve => setTimeout(resolve, 350));
    if (this.latest !== query && this.latest.startsWith(query)) return none;
    // Titles, lyrics and albums are asked together; a lyrics or album failure never hides the title matches.
    const words = this.lyrics ? this.lyrics(query).then(r => r.results, () => [] as Track[]) : Promise.resolve([] as Track[]);
    const found = this.albums && this.openAlbum
      ? this.albums(query).then(r => r.albums.filter(a => a.kind !== 'single').slice(0, CAR_ALBUMS), () => [])
      : Promise.resolve([]);
    const opened = found.then(list => Promise.all(list.map(a => this.openAlbum!(a.id).then(r => r.album, () => null))));
    const [result, byWords, bodies] = await Promise.all([this.lookup(query), words, opened]);
    const albums: NativeAlbum[] = [];
    for (const a of bodies) {
      if (!a || !a.tracks.length) continue;
      this.albumTracks.delete(a.id);
      this.albumTracks.set(a.id, a.tracks);
      albums.push({
        id: a.id, title: a.title, artist: a.artist, artwork: a.artwork,
        songs: a.tracks.slice(0, CAR_ALBUM_SONGS).map(t => ({ ...songFromTrack(t, this.ready(t)), id: carAlbumTrackId(a.id, t.key) })),
      });
    }
    while (this.albumTracks.size > 20) this.albumTracks.delete(this.albumTracks.keys().next().value!);
    const states = Object.values(result.sources ?? {});
    if (!result.results.length && !byWords.length && !albums.length && states.length && !states.some(s => s.state === 'ok')) {
      throw new Error('Music search is unavailable. Check your connection and try again.');
    }
    const rows = [...new Map([...result.results, ...byWords].filter(t => t.key && t.title).map(t => [t.key, t])).values()].slice(0, 25);
    for (const track of rows) {
      this.tracks.delete(track.key);
      this.tracks.set(track.key, track);
    }
    while (this.tracks.size > 200) this.tracks.delete(this.tracks.keys().next().value!);
    // A voice request for the album, or words that name it, plays the album from its first song.
    const lead = albums[0];
    const play = lead && (opts.album || namesAlbum(query, lead.title)) ? lead.songs[0]?.id ?? null : null;
    return { songs: rows.map(t => songFromTrack(t, this.ready(t))), albums, play };
  }
}
