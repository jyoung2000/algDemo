import { useEffect, useRef, useState } from 'react';
import './artist-spacing.css';
import './album-spacing.css';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { SourceMark } from './SourceMark';
import { RefreshGlyph } from './icons';
import { api, ApiError, type AlbumSummary, type ArtistExtras, type ArtistSourceState, type ArtistTarget, type ArtistView as ArtistData, type PlaylistSummary, type Track } from './api';
import { Art } from './Art';
import { AlbumShelf } from './AlbumShelf';
import { ListSaveButton } from './ListSaveButton';
import { TrackList } from './Search';
import { TypeFilter, toggleType } from './TypeFilter';
import { Develop, Skeleton, SkeletonList } from './Skeleton';
import type { ResultType } from './result-types';
import { PROVIDER_LABEL, classNames } from './util';
import { songKey } from './engine/song-key';
import { cleanAlbumTitle } from './engine/album-key';
import { fold } from './engine/identity';
import './artist-section.css';
import { ArtistCircle } from './ArtistCircle';

/** RESULT-TYPES-001: the icon menu near the top of the discography. */
const PAGE_TYPES: readonly ResultType[] = ['singles', 'albums', 'features', 'songs'];

export type { ArtistTarget } from './api';
export { ArtistCard, ArtistNames, artistTargetsOf, namesArtist } from './ArtistLinks';

export const artistTargetKey = (t: ArtistTarget): string => t.id ?? `name:${(t.name ?? '').toLowerCase()}`;

/** Songs shown before "Show all": enough to start from, short enough that the albums stay in reach. */
export const SONGS_FOLDED = 10;

interface Props {
  target: ArtistTarget;
  onBack: () => void;
  onPreview: (t: Track, list: Track[]) => void;
  /** SHUFFLE-START-001: play the whole list; the app chooses the song it starts on. */
  onPlayAll?: (list: Track[]) => void;
  onOpenAlbum: (a: AlbumSummary) => void;
  onOpenArtist: (t: ArtistTarget) => void;
  seedKeys: Set<string>;
  onAdd: (t: Track) => void;
  onDownload?: ((t: Track) => void) | undefined;
  onLike?: ((t: Track, like: boolean) => void) | undefined;
  onRemoveSeed?: ((t: Track) => void) | undefined;
  lists?: PlaylistSummary[] | undefined;
  onLists?: ((lists: PlaylistSummary[]) => void) | undefined;
  onQueueAdd?: ((t: Track) => void) | undefined;
  addLabel?: string | undefined;
  addedKeys?: ReadonlySet<string> | undefined;
  playingKey?: string | null | undefined;
}

type State = { state: 'loading' } | { state: 'ready'; artist: ArtistData } | { state: 'failed'; message: string };
type Every = { state: 'loading' } | { state: 'ready'; songs: Track[]; features: Track[]; failed: number; featuresComplete: boolean } | { state: 'failed' };
/** FEATURES-ALL-001: the songs other artists have them on, asked for on their own. A look again keeps what was found. */
type More = { state: 'loading' | 'failed'; features: Track[] } | { state: 'ready'; features: Track[]; complete: boolean };
/** ARTIST-ALL-SOURCES-001: what the other platforms add, asked for once the page is up. */
type Extra = { state: 'loading' | 'failed' } | { state: 'ready'; extras: ArtistExtras };
type RefreshTarget = ArtistTarget & { refresh?: boolean; refreshToken?: string };
/** Refresh adds rows; a slow or unavailable source must not take visible results away. */
const appendRows = <T,>(old: readonly T[], next: readonly T[], key: (row: T) => string): T[] => {
  const seen = new Set(old.map(key));
  return [...old, ...next.filter((row) => { const k = key(row); if (seen.has(k)) return false; seen.add(k); return true; })];
};
const keepSongs = (old: readonly Track[], next: readonly Track[]) => appendRows(old, next, songKey);
const keepAlbums = (old: readonly AlbumSummary[], next: readonly AlbumSummary[]) => appendRows(old, next, (row) => row.id);

/** FEATURES-FLOW-001: a stop for a look that never ends; a real one is over in a few dozen answers. */
const FEATURE_ASKS = 400;
/** OPEN-HEAL-001: how long after opening, then after each try, a page with a busy service asks again. */
// Measured: a held request is refused after seven to nine seconds and answers when asked again, so
// the whole page is usually there eight to twelve seconds after the page opened. Asking is a read of
// what the app already holds, not a request to the service.
const HEAL_WAITS_MS = [3000, 5000, 8000, 15000, 30000];
const busySources = (a: ArtistData) => Object.values(a.sources ?? {}).filter((x) => x.state === 'failed' && x.why === 'busy').length;
/** The platforms asked after the page opens, in the order they are named. */
const EXTRA_PLATFORMS = ['soundcloud', 'apple', 'bandcamp', 'audius'] as const;
const listOf = (names: readonly string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const EXTRA_NAMES = listOf(EXTRA_PLATFORMS.map((p) => PROVIDER_LABEL[p] ?? p));
const recordKey = (r: Pick<AlbumSummary, 'title'>) => fold(cleanAlbumTitle(r.title));
const newestFirst = (list: AlbumSummary[]) => list.map((a, i) => ({ a, i })).sort((x, y) => Number(y.a.year ?? 0) - Number(x.a.year ?? 0) || x.i - y.i).map((x) => x.a);

const songs = (n: number) => `${n} ${n === 1 ? 'song' : 'songs'}`;

/** One platform on the artist page: what the page shows from it, and whether its own page was read. */
export interface SourceRow {
  provider: string;
  label: string;
  parts: string[];
  failed: boolean;
  text: string;
}

const SOURCE_ORDER = ['deezer', 'ytmusic', 'apple', 'spotify', 'soundcloud', 'bandcamp', 'audius', 'hearthis', 'archive'];
/** Why a platform's artist page was not read, to follow "page not read: ". */
const NOT_READ: Record<string, string> = {
  allowance: 'today\u2019s allowance is used up',
  offline: 'no connection',
  busy: 'the service is busy',
  refused: 'the service refused the request',
  failed: 'it answered with an error',
};
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * ARTIST-SOURCES-001. Owner: "dont just list deezer, list all the different platforms / sources the
 * artist information is coming from". Every platform something on the page came from, with what:
 * its songs, features, albums and singles are counted from the rows themselves (each carries the
 * platform it was read from), the picture and audience figure from what the engine recorded. A
 * platform whose page was not read says why. One that answered and added nothing is not listed.
 */
export function artistSources(a: ArtistData, songsShown: readonly Track[], feats: readonly Track[]): SourceRow[] {
  const tally = new Map<string, { songs: number; features: number; albums: number; singles: number }>();
  const at = (p: unknown) => {
    const k = String(p ?? '');
    if (!k) return null;
    let n = tally.get(k);
    if (!n) tally.set(k, (n = { songs: 0, features: 0, albums: 0, singles: 0 }));
    return n;
  };
  for (const t of songsShown) { const n = at(t.provider); if (n) n.songs++; }
  for (const t of feats) { const n = at(t.provider); if (n) n.features++; }
  for (const x of a.albums) { const n = at(x.provider); if (n) n.albums++; }
  for (const x of a.singles) { const n = at(x.provider); if (n) n.singles++; }
  const rank = (p: string) => { const i = SOURCE_ORDER.indexOf(p); return i < 0 ? SOURCE_ORDER.length : i; };
  const providers = [...new Set([...tally.keys(), ...Object.keys(a.sources ?? {})])].sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
  const rows: SourceRow[] = [];
  for (const provider of providers) {
    const n = tally.get(provider);
    const s = a.sources?.[provider];
    const failed = s?.state === 'failed';
    const parts = [
      n?.songs ? count(n.songs, 'song', 'songs') : null,
      n?.features ? count(n.features, 'feature', 'features') : null,
      n?.albums ? count(n.albums, 'album', 'albums') : null,
      n?.singles ? count(n.singles, 'single', 'singles') : null,
      ...(s?.state === 'ok' ? s.gave ?? [] : []),
      // ARTIST-ALL-SOURCES-001: a platform that was read and held nothing the page lacked is still
      // accounted for, and an account the platform does not vouch for is named as one.
      s?.state === 'ok' && !n && (s.checked ?? 0) > 0 ? `all ${s.checked} already listed` : null,
      s?.state === 'ok' && n && s.note === 'unverified' ? 'unverified account' : null,
      failed ? `page not read: ${NOT_READ[s?.why ?? 'failed'] ?? NOT_READ['failed']!}` : null,
    ].filter((x): x is string => Boolean(x));
    if (!parts.length) continue;
    const label = PROVIDER_LABEL[provider] ?? provider;
    rows.push({ provider, label, parts, failed, text: [label, ...parts].join(' \u00B7 ') });
  }
  return rows;
}

/** ARTIST-ALL-SOURCES-001: the platforms that answered and have no page that is this artist's. */
export function alsoChecked(sources: Readonly<Record<string, ArtistSourceState>> | undefined): string[] {
  return EXTRA_PLATFORMS.filter((p) => sources?.[p]?.state === 'none').map((p) => PROVIDER_LABEL[p] ?? p);
}

/**
 * ARTIST-PAGE-001. Owner: "can we add artist pages where we can see all of an artist songs and
 * albums". Opens on the most played songs; every song on every album and single follows a moment
 * later, so "Show all" lists everything the artist has released. Albums, EPs and singles open as
 * album pages. Every song plays as the full song, as from a search.
 *
 * ARTIST-FEATURES-001. Owner: "clicking on a artist name should take you to a discography page where
 * you can see all there albums, singles and features". The page is that discography: their songs,
 * their albums and EPs, their singles, then the songs other artists have them on, each naming the
 * artist it belongs to so one page leads on to the next.
 */
export function ArtistView({ target, onBack, onPreview, onPlayAll, onOpenAlbum, onOpenArtist, seedKeys, onAdd, onDownload, onLike, onRemoveSeed, lists, onLists, onQueueAdd, addLabel, addedKeys, playingKey }: Props) {
  const [st, setSt] = useState<State>({ state: 'loading' });
  const [every, setEvery] = useState<Every>({ state: 'loading' });
  const [more, setMore] = useState<More>({ state: 'loading', features: [] });
  const [extra, setExtra] = useState<Extra>({ state: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState('');
  const [all, setAll] = useState(false);
  const [allFeat, setAllFeat] = useState(false);
  const [types, setTypes] = useState<ReadonlySet<ResultType>>(() => new Set());
  const showing = (t: ResultType) => types.size === 0 || types.has(t);
  const back = useRef<HTMLButtonElement>(null);
  const live = useRef<AbortController | null>(null);
  const liveFeat = useRef<AbortController | null>(null);
  const activeTarget = useRef<RefreshTarget | null>(null);
  const refreshRun = useRef(false);

  useEffect(() => back.current?.focus({ preventScroll: true }), []);

  // Every song on every album and single. A look again keeps the features already confirmed and adds
  // the ones the new answer finds, so a retry never takes a feature away (ARTIST-FEATURES-001).
  const loadSongs = (t: RefreshTarget, c: AbortController) =>
    api.artistSongs(t, c.signal).then(
      (s) => {
        if (c.signal.aborted) return;
        // ARTIST-FALLBACK-002: an answer without a song list is a failed look, never a ready page.
        if (!Array.isArray(s.songs)) {
          setEvery((was) => (was.state === 'ready' ? was : { state: 'failed' }));
          return;
        }
        setEvery((was) => {
          const had = was.state === 'ready' ? was.features : [];
          const keys = new Set(had.map((x) => x.key));
          const features = [...had, ...(s.features ?? []).filter((x) => !keys.has(x.key))];
          return { state: 'ready', songs: t.refresh && was.state === 'ready' ? keepSongs(was.songs, s.songs) : s.songs, features, failed: s.failed, featuresComplete: s.featuresComplete !== false };
        });
        return s.failed === 0;
      },
      () => { if (!c.signal.aborted) setEvery((was) => (was.state === 'ready' ? was : { state: 'failed' })); },
    );

  // FEATURES-ALL-001: the features, on their own. A second look only ever adds to what the first found.
  // FEATURES-FLOW-001: the look is taken a few seconds at a time. Each answer has everything confirmed
  // so far and is listed at once; the page asks again while `more` remains and stops when it is left.
  const loadFeatures = async (t: RefreshTarget) => {
    liveFeat.current?.abort();
    const c = new AbortController();
    liveFeat.current = c;
    setMore((was) => ({ state: 'loading', features: was.features }));
    try {
      for (let asked = 0; asked < FEATURE_ASKS; asked++) {
        const r = await api.artistFeatures(t, c.signal);
        if (c.signal.aborted) return;
        const got = Array.isArray(r?.features) ? r.features : null;
        const again = got !== null && r.more === true;
        setMore((was) => {
          const keys = new Set(was.features.map((x) => x.key));
          const features = [...was.features, ...(got ?? []).filter((x) => !keys.has(x.key))];
          if (!got) return { state: 'failed', features };
          return again ? { state: 'loading', features } : { state: 'ready', features, complete: r.complete !== false };
        });
        if (!again) return got !== null && r.complete !== false;
      }
      // Far more answers than any look needs: it ends as an incomplete one, with "Look again" to hand.
      setMore((was) => ({ state: 'ready', features: was.features, complete: false }));
    } catch {
      if (!c.signal.aborted) setMore((was) => ({ state: 'failed', features: was.features }));
    }
  };

  const loadSources = (t: RefreshTarget, c: AbortController) => api.artistSources(t, c.signal).then(
    (x) => {
      if (c.signal.aborted) return false;
      if (!x || !Array.isArray(x.songs) || !Array.isArray(x.albums) || !Array.isArray(x.singles)) {
        setExtra((was) => was.state === 'ready' ? was : { state: 'failed' });
        return false;
      }
      setExtra((was) => ({ state: 'ready', extras: t.refresh && was.state === 'ready' ? {
        ...x, songs: keepSongs(was.extras.songs, x.songs), albums: keepAlbums(was.extras.albums, x.albums), singles: keepAlbums(was.extras.singles, x.singles),
      } : x }));
      return !Object.values(x.sources).some((s) => s.state === 'failed');
    },
    () => { if (!c.signal.aborted) setExtra((was) => was.state === 'ready' ? was : { state: 'failed' }); return false; },
  );

  const refresh = async (shown: ArtistData) => {
    if (refreshRun.current) return;
    refreshRun.current = true;
    live.current?.abort(); liveFeat.current?.abort();
    const c = new AbortController(); live.current = c;
    const t: RefreshTarget = { id: shown.id, name: shown.name, refresh: true, refreshToken: crypto.randomUUID() };
    activeTarget.current = t;
    setRefreshing(true); setRefreshNote('');
    // A refresh can begin while the first full song list is still loading. Anchor the visible
    // top songs before a thinner refreshed answer arrives, just as for an already-loaded list.
    setEvery((was) => was.state === 'ready' ? was : { state: 'ready', songs: shown.songs, features: [], failed: 0, featuresComplete: true });
    let pageFailed = false;
    try {
      const r = await api.artist(t, c.signal);
      if (c.signal.aborted) return;
      setSt((was) => ({ state: 'ready', artist: was.state === 'ready' ? {
        ...r.artist, songs: keepSongs(was.artist.songs, r.artist.songs), features: keepSongs(was.artist.features ?? [], r.artist.features ?? []),
        albums: keepAlbums(was.artist.albums, r.artist.albums), singles: keepAlbums(was.artist.singles, r.artist.singles),
      } : r.artist }));
    } catch { pageFailed = true; }
    if (c.signal.aborted) return;
    // Even when the main page fails, the other sources can still add to the visible page.
    const results = await Promise.all([loadSongs(t, c), loadFeatures(t), loadSources(t, c)]);
    if (c.signal.aborted) return;
    setRefreshNote(pageFailed || results.some((ok) => !ok) ? 'Some artist sources could not be refreshed. Your results are kept; try refreshing again.' : 'Artist sources refreshed.');
    refreshRun.current = false; setRefreshing(false);
  };

  // App mounts a fresh view for each artist (keyed by artistTargetKey), so loading is the initial state.
  useEffect(() => {
    const c = new AbortController();
    live.current = c;
    // Asked once the page is up, so it never holds it up. They are asked together.
    const follow = (a: ArtistData) => {
      const t = { id: a.id, name: a.name };
      activeTarget.current = t;
      void loadSongs(t, c);
      void loadFeatures(t);
      // ARTIST-ALL-SOURCES-001: the other platforms, asked beside the rest so nothing waits on them.
      void loadSources(t, c);
    };
    // OPEN-HEAL-001: a page that opened without a busy service asks for itself again, quietly, a few
    // times. When the service has answered by then the page is mended in place: what is on it stays,
    // and the songs, features and other platforms are asked for again with the fuller page.
    const mend = (shown: ArtistData, tries: number) => {
      const wait = HEAL_WAITS_MS[tries];
      if (wait === undefined || busySources(shown) === 0) return;
      const timer = setTimeout(() => {
        api.artist(target, c.signal).then(
          (r) => {
            if (c.signal.aborted) return;
            if (busySources(r.artist) >= busySources(shown)) return mend(shown, tries + 1);
            setSt({ state: 'ready', artist: r.artist });
            follow(r.artist);
            mend(r.artist, tries + 1);
          },
          () => { if (!c.signal.aborted) mend(shown, tries + 1); },
        );
      }, wait);
      c.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    };
    api.artist(target, c.signal).then(
      (r) => {
        if (c.signal.aborted) return;
        setSt({ state: 'ready', artist: r.artist });
        follow(r.artist);
        mend(r.artist, 0);
      },
      (e: unknown) => {
        if (c.signal.aborted) return;
        setSt({ state: 'failed', message: e instanceof ApiError ? e.message : 'The artist could not be opened. Check the connection and try again.' });
      },
    );
    return () => { live.current?.abort(); liveFeat.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const lookAgain = (a: ArtistData) => {
    if (refreshRun.current) return;
    const t = activeTarget.current ?? { id: a.id, name: a.name };
    // The songs are asked for again only when it was their answer that fell short.
    if (every.state === 'ready' && !every.featuresComplete) {
      live.current?.abort();
      const c = new AbortController();
      live.current = c;
      void loadSongs(t, c);
    }
    if (!(more.state === 'ready' && more.complete)) void loadFeatures(t);
  };

  const listProps = { seedKeys, onAdd, onPreview, onDownload, onLike, onRemoveSeed, lists, onLists, onQueueAdd, addLabel, addedKeys, playingKey, onOpenArtist };

  return (
    <section className="card album artist" aria-labelledby="artist-h" aria-busy={st.state === 'loading' || refreshing}>
      <div className="album__bar artist__bar">
        <button ref={back} className="push album__back" type="button" onClick={onBack} aria-label="Back">
          <Glyph name="chevron-left" size={14} /> Back
        </button>
        {st.state === 'ready' && <button className="iconbtn artist__refresh" type="button" disabled={refreshing} aria-label="Refresh artist" aria-busy={refreshing} onClick={() => { void refresh(st.artist); }} title={refreshing ? 'Refreshing artist sources…' : 'Refresh artist sources and features'}>
          <RefreshGlyph />
        </button>}
      </div>
      {refreshNote && <p className="state" role="status">{refreshNote}</p>}
      {st.state === 'loading' && (
        /* SKELETON-001: the page's own shape while it loads — the 112px portrait with the name
           lines beside it, then song rows — with one status label for screen readers. */
        <div role="status" aria-label="Opening the artist…">
          <span className="vh">Opening the artist…</span>
          <div className="skel-row" aria-hidden="true">
            <Skeleton kind="art" w={112} h={112} />
            <span className="skel-row__text">
              <Skeleton kind="line" w={56} h={10} />
              <Skeleton kind="line" w="44%" h={20} />
              <Skeleton kind="line" w="30%" />
            </span>
          </div>
          <SkeletonList rows={5} label="Loading songs…" />
        </div>
      )}
      {st.state === 'failed' && (
        <p className="state state--bad" role="alert">
          <Glyph name="warning" size={14} /> {st.message}
        </p>
      )}
      {st.state === 'ready' && (() => {
        const page = st.artist;
        const own = every.state === 'ready' ? every.songs : page.songs;
        // ARTIST-ALL-SOURCES-001: what the other platforms add. Their records join the shelves at
        // once (the page has every album from the start); their songs wait until the artist's own
        // list is whole, so one that an album turns out to hold never shows and then goes.
        const x = extra.state === 'ready' ? extra.extras : null;
        // What they add was worked out against the page as it was then; a page read again since (a
        // service that was slow the first time) may now hold one of those records itself.
        const held = new Set([...page.albums, ...page.singles].map(recordKey));
        const lacks = (list: readonly AlbumSummary[] | undefined) => (list ?? []).filter((r) => !held.has(recordKey(r)));
        const a: ArtistData = x
          ? { ...page, albums: newestFirst([...page.albums, ...lacks(x.albums)]), singles: newestFirst([...page.singles, ...lacks(x.singles)]), sources: { ...page.sources, ...x.sources } }
          : page;
        let full = own;
        if (x && x.songs.length && every.state !== 'loading') {
          const have = new Set(own.map(songKey));
          const added = x.songs.filter((t) => { const k = songKey(t); return !have.has(k) && (have.add(k), true); });
          if (added.length) full = [...own, ...added];
        }
        const none = alsoChecked(a.sources);
        // ARTIST-FEATURES-001: the page's own features, then the ones the deferred search confirmed.
        const feats: Track[] = [];
        const featKeys = new Set<string>();
        for (const t of [...(a.features ?? []), ...(every.state === 'ready' ? every.features : []), ...more.features]) {
          if (featKeys.has(t.key)) continue;
          featKeys.add(t.key);
          feats.push(t);
        }
        full = full.filter(t => !featKeys.has(t.key));
        const shown = all ? full : full.slice(0, SONGS_FOLDED);
        const featsWaiting = more.state === 'loading';
        const featsShort = (every.state === 'ready' && !every.featuresComplete) || more.state === 'failed' || (more.state === 'ready' && !more.complete);
        // FEATURES-ALL-002: with Features the chosen type the page IS the feature list, so all of it shows.
        const featsOpen = allFeat || (types.size === 1 && types.has('features'));
        const featsShown = featsOpen ? feats : feats.slice(0, SONGS_FOLDED);
        const srcs = artistSources(a, full, feats);
        // Only the two services the page itself is built from decide what the local page's note says.
        const missed = Object.values(page.sources ?? {}).find((s) => s.state === 'failed');
        const meta = [
          a.detail,
          every.state === 'ready' ? songs(full.length) : null,
          a.albums.length ? `${a.albums.length} ${a.albums.length === 1 ? 'album' : 'albums'}` : null,
          feats.length ? `${feats.length} ${feats.length === 1 ? 'feature' : 'features'}` : null,
        ].filter((x): x is string => Boolean(x));
        return (
          /* SKELETON-001: the loaded page develops into focus where the skeleton stood. */
          <Develop>
            {a.local && (
              // ARTIST-FALLBACK-001: say plainly why the page is thin, and show what this app holds by
              // the name, instead of a dead end. ARTIST-SOURCES-001: "has no page" is said only of
              // services that answered; one that was not read gets its real reason.
              <p className="state album__note" role="status">
                <Glyph name="info" size={14} />{' '}
                {missed
                  ? <>{a.name}{'\u2019'}s page could not be read: {NOT_READ[missed.why ?? 'failed'] ?? NOT_READ['failed']}.</>
                  : <>Neither Deezer nor YouTube Music has a page for{' \u201C'}{a.name}{'\u201D'}.</>}
                {' '}{a.songs.length || (a.features?.length ?? 0)
                  ? 'These are the songs you already have by them.'
                  : 'You have no songs by them yet, so there is nothing to show.'}
              </p>
            )}
            <div className="album__head">
              <span className="artist-pic">
                <Art src={a.picture} size={112} />
              </span>
              <div className="album__text">
                <span className="album__kind">Artist</span>
                <h2 id="artist-h" className="album__title">{a.name}</h2>
                {meta.length > 0 && (
                  <span className="album__meta">
                    {meta.map((part, i) => (
                      <span key={part}>
                        {i > 0 && ' · '}
                        <span className="artist__part">{part}</span>
                      </span>
                    ))}
                  </span>
                )}
                {(srcs.length > 0 || extra.state !== 'ready' || none.length > 0) && (
                  <ul className="artist__sources" aria-label={`Where ${a.name}\u2019s information comes from`}>
                    {srcs.map((r) => (
                      <li key={r.provider} className={classNames('artist__source', r.failed && 'is-failed')}>
                        <SourceMark provider={r.provider} size={13} />
                        <span className="artist__source-text">
                          <span className="artist__source-name">{r.label}</span>
                          {r.parts.map((part) => (
                            <span key={part} className={part.startsWith('page not read') ? 'artist__source-miss' : undefined}>{' \u00B7 '}{part}</span>
                          ))}
                        </span>
                      </li>
                    ))}
                    {extra.state === 'loading' && (
                      <li className="artist__source artist__source--wait" role="status">
                        <span className="sdot sdot--busy" aria-hidden="true" />
                        <span className="artist__source-text">Checking {EXTRA_NAMES}{'\u2026'}</span>
                      </li>
                    )}
                    {extra.state === 'failed' && <li className="artist__source artist__also">{EXTRA_NAMES} could not be checked.</li>}
                    {extra.state === 'ready' && none.length > 0 && (
                      <li className="artist__source artist__also">Also checked: {listOf(none)} {none.length === 1 ? 'has' : 'have'} no page for {a.name}.</li>
                    )}
                  </ul>
                )}
              </div>
            </div>
            <div className="album__actions">
              <button className="push push--default artist__play" type="button" disabled={!full.length}
                aria-label={`Play songs by ${a.name}`} title={`Play songs by ${a.name}`}
                onClick={() => (onPlayAll ? onPlayAll(full) : onPreview(full[0]!, full))}>
                <Glyph name="play" size={16} />
              </button>
              {/* LIST-SAVE-FOLDER-001: every song, downloaded into a folder named after the artist. */}
              {every.state === 'ready' && <ListSaveButton tracks={full} kind="list" name={a.name} label={`every song by ${a.name}`} />}
            </div>
            <TypeFilter
              types={PAGE_TYPES}
              selected={types}
              onToggle={(t) => setTypes((s) => toggleType(s, t))}
              counts={{ songs: full.length, albums: a.albums.length, singles: a.singles.length, features: feats.length }}
            />
            {showing('songs') && (
              <>
                <div className="artist__songs-heading">
                  <h3 id="artist-songs-heading" className="albums__h">{all && every.state === 'ready' ? 'All songs' : 'Most played'}</h3>
                  {/* ARTIST-TOP-PLAY-001: play this section as a list, not the hidden full catalogue. */}
                  <button className="btn artist__section-play" type="button" disabled={!shown.length}
                    aria-label={`Play ${all && every.state === 'ready' ? 'all' : 'most played'} songs by ${a.name}`}
                    aria-describedby="artist-songs-heading"
                    title={`Play ${all && every.state === 'ready' ? 'all' : 'most played'} songs by ${a.name}`}
                    onClick={() => (onPlayAll ? onPlayAll(shown) : onPreview(shown[0]!, shown))}>
                    <Glyph name="play" size={14} />
                  </button>
                </div>
                {full.length ? (
                  <TrackList tracks={shown} {...listProps} label={`Songs by ${a.name}`} />
                ) : (
                  <p className="empty">No songs by {a.name} were found.</p>
                )}
              </>
            )}
            <div className="artist__more">
              {every.state === 'loading' && (
                <p className="state" role="status">
                  <span className="sdot sdot--busy" aria-hidden="true" /> Finding every song on {a.name}’s albums and singles…
                </p>
              )}
              {every.state === 'failed' && (
                <p className="state" role="status">
                  <Glyph name="info" size={14} /> Only the most played songs could be listed. The albums below still open.
                </p>
              )}
              {showing('songs') && !all && full.length > SONGS_FOLDED && (
                <button type="button" className="linkbtn albums__more" onClick={() => setAll(true)}>
                  {every.state === 'ready' ? `Show all ${full.length} songs` : `Show all ${full.length} most played`}
                </button>
              )}
              {every.state === 'ready' && every.failed > 0 && (
                <p className="state" role="status">
                  <Glyph name="info" size={14} /> {every.failed === 1 ? '1 album could not be read' : `${every.failed} albums could not be read`}, so their songs may be missing.
                </p>
              )}
            </div>
            {showing('albums') && a.albums.length > 0 && <AlbumShelf albums={a.albums} query={a.name} onOpen={onOpenAlbum} title="Albums and EPs" label={`Albums by ${a.name}`} folded={6} noun="albums" />}
            {showing('singles') && a.singles.length > 0 && <AlbumShelf albums={a.singles} query={a.name} onOpen={onOpenAlbum} title="Singles" label={`Singles by ${a.name}`} folded={6} noun="singles" />}
            {showing('features') && (feats.length > 0 || featsWaiting || featsShort) && (
              <>
                <h3 className="albums__h">Features{feats.length > 0 ? ` (${feats.length})` : ''}</h3>
                {feats.length > 0 && (
                  <>
                    <p className="artist__hint">Guest appearances confirmed by Deezer contributor credits or linked YouTube Music artist credits. We follow available search pages; catalogue omissions or unavailable sources can still leave gaps.</p>
                    <TrackList tracks={featsShown} {...listProps} label={`Songs featuring ${a.name}`} />
                  </>
                )}
                <div className="artist__more">
                  {!featsOpen && feats.length > SONGS_FOLDED && (
                    <button type="button" className="linkbtn albums__more" onClick={() => setAllFeat(true)}>
                      Show all {feats.length} features
                    </button>
                  )}
                  {/* FEATURES-ALL-001: the wait is named where the features will appear. */}
                  {featsWaiting && (
                    <p className="state artist__feat-wait" role="status">
                      <span className="sdot sdot--busy" aria-hidden="true" /> Looking for more songs other artists have {a.name} on…
                    </p>
                  )}
                  {!featsWaiting && featsShort && (
                    <p className="state" role="status">
                      <Glyph name="info" size={14} /> Not every feature could be looked up, so some may be missing.{' '}
                      <button type="button" className="linkbtn" onClick={() => lookAgain(a)}>Look again</button>
                    </p>
                  )}
                </div>
              </>
            )}
            {/* ARTIST-CIRCLE-001: who they work with, and who sounds like them. */}
            {types.size === 0 && !a.local && (
              <ArtistCircle name={a.name} songs={full} features={feats} similar={a.similar ?? []} waiting={every.state === 'loading' || featsWaiting} onOpenArtist={onOpenArtist} />
            )}
            {types.size > 0 && !(types.has('features') && (featsWaiting || featsShort)) && PAGE_TYPES.filter((t) => types.has(t)).every((t) => (t === 'songs' ? full.length : t === 'albums' ? a.albums.length : t === 'singles' ? a.singles.length : feats.length) === 0) && (
              <p className="state" role="status">
                <Glyph name="info" size={14} /> {a.name} has nothing of that kind here. Tap the highlighted icon again to show everything.
              </p>
            )}
          </Develop>
        );
      })()}
    </section>
  );
}
