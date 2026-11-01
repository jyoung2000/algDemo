import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Glyph, ProviderMark } from '@now-playing/aqua-ui/icons';
import { api, ApiError, type ResolveResponse, type SearchResponse, type SourceState, type Track } from './api';
import { Art } from './Art';
import { PROVIDER_LABEL, artistOf, classNames, fmtDuration, fmtRelease, looksLikeUrl, markKey } from './util';

interface Props {
  seeds: Track[];
  onAdd: (t: Track) => void;
  onPreview: (t: Track) => void;
  onDownload?: (t: Track) => void;
}

type View =
  | { kind: 'idle' }
  | { kind: 'loading'; what: 'search' | 'link' }
  | { kind: 'results'; tracks: Track[]; sources: Record<string, SourceState>; query: string; ms: number }
  | { kind: 'choice'; res: Extract<ResolveResponse, { kind: 'choice' }> }
  | { kind: 'error'; message: string };

const AUTOCOMPLETE_MS = 450;

/**
 * The one prominent field. Titles search live providers (debounced while typing, immediately on
 * Enter); links are resolved on Enter, on Search or when pasted. A newer request aborts the older one.
 * Typing is never a preference signal: only the Add button makes a starting song.
 */
export function Search({ seeds, onAdd, onPreview, onDownload }: Props) {
  const [q, setQ] = useState('');
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [artistFix, setArtistFix] = useState('');
  const ctl = useRef<AbortController | null>(null);
  const timer = useRef<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const seedKeys = new Set(seeds.map((s) => s.key));

  const cancel = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    ctl.current?.abort();
    ctl.current = null;
  };

  const run = async (text: string) => {
    const s = text.trim();
    cancel();
    if (!s) {
      setView({ kind: 'idle' });
      return;
    }
    const c = new AbortController();
    ctl.current = c;
    const link = looksLikeUrl(s);
    setView({ kind: 'loading', what: link ? 'link' : 'search' });
    try {
      if (link) {
        const r = await api.resolve(s, c.signal);
        if (c.signal.aborted) return;
        if (r.kind === 'track') setView({ kind: 'results', tracks: [r.track], sources: { [r.track.provider]: { state: 'ok', count: 1, ms: r.ms } }, query: s, ms: r.ms });
        else if (r.kind === 'choice') setView({ kind: 'choice', res: r });
        else setView({ kind: 'error', message: r.message });
      } else {
        const r: SearchResponse = await api.search(s, c.signal);
        if (c.signal.aborted) return;
        setView({ kind: 'results', tracks: r.results, sources: r.sources, query: s, ms: r.ms });
      }
    } catch (e) {
      if (c.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
      setView({ kind: 'error', message: e instanceof ApiError ? e.message : 'The discovery server did not answer. Is it running?' });
    }
  };

  const onChange = (v: string) => {
    setQ(v);
    if (timer.current != null) window.clearTimeout(timer.current);
    const s = v.trim();
    if (s.length >= 3 && !looksLikeUrl(s)) timer.current = window.setTimeout(() => void run(s), AUTOCOMPLETE_MS);
    else if (!s) {
      cancel();
      setView({ kind: 'idle' });
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(q);
  };

  useEffect(() => cancel, []);

  const fixSpotify = async (title: string) => {
    if (!artistFix.trim()) return;
    setView({ kind: 'loading', what: 'search' });
    try {
      const r = await api.completeSpotify(title, artistFix.trim());
      setView({ kind: 'results', tracks: r.tracks, sources: {}, query: `${artistFix} ${title}`, ms: 0 });
    } catch (e) {
      setView({ kind: 'error', message: e instanceof ApiError ? e.message : 'That search failed.' });
    }
  };

  return (
    <section className={'search'} aria-label="Find songs">
      <form className="search__form" role="search" onSubmit={submit}>
        <label className="sr" htmlFor="q">
          Search a song or paste a music link
        </label>
        <span className="search__icon" aria-hidden="true">
          <Glyph name="search" size={16} />
        </span>
        <input
          ref={input}
          id="q"
          className="field search__field"
          type="search"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search a song or paste a music link"
          value={q}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text');
            if (looksLikeUrl(t)) {
              e.preventDefault();
              setQ(t.trim());
              void run(t);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && q) {
              e.preventDefault();
              setQ('');
              cancel();
              setView({ kind: 'idle' });
            }
          }}
          aria-describedby="q-hint"
        />
        <button className="push push--default" type="submit" disabled={!q.trim()}>
          Search
        </button>
      </form>
      <p id="q-hint" className="search__hint">
        Song titles, or links from Spotify, SoundCloud, YouTube, YouTube Music and Deezer.
      </p>

      <div aria-live="polite" aria-busy={view.kind === 'loading'}>
        {view.kind === 'loading' && (
          <p className="state">
            <span className="sdot sdot--busy" aria-hidden="true" />
            {view.what === 'link' ? 'Reading the link…' : 'Searching…'}
          </p>
        )}
        {view.kind === 'error' && (
          <p className="state state--bad" role="alert">
            <Glyph name="warning" size={14} /> {view.message}
          </p>
        )}
        {view.kind === 'choice' && (
          <div className="choice">
            <p className="state">
              <Glyph name="info" size={14} /> {view.res.message}
            </p>
            {view.res.choice === 'artist' && view.res.track && (
              <form
                className="choice__fix"
                onSubmit={(e) => {
                  e.preventDefault();
                  void fixSpotify(view.res.track!.title);
                }}
              >
                <label htmlFor="artist-fix">Artist of “{view.res.track.title}”</label>
                <input id="artist-fix" className="field" value={artistFix} onChange={(e) => setArtistFix(e.target.value)} placeholder="Type the artist" />
                <button className="push" type="submit" disabled={!artistFix.trim()}>
                  Find it
                </button>
              </form>
            )}
            {view.res.tracks.length > 0 && <TrackList tracks={view.res.tracks} seedKeys={seedKeys} onAdd={onAdd} onPreview={onPreview} onDownload={onDownload} label="Choose a song" />}
          </div>
        )}
        {view.kind === 'results' &&
          (view.tracks.length ? (
            <>
              <SourceLine sources={view.sources} />
              <TrackList tracks={view.tracks} seedKeys={seedKeys} onAdd={onAdd} onPreview={onPreview} onDownload={onDownload} label={`Results for ${view.query}`} />
            </>
          ) : (
            <p className="state">
              No songs found for “{view.query}”.
              {Object.values(view.sources).some((s) => s.state !== 'ok') ? ' Some sources did not answer; try again in a moment.' : ' Try the artist and title together.'}
            </p>
          ))}
      </div>
    </section>
  );
}

function SourceLine({ sources }: { sources: Record<string, SourceState> }) {
  const entries = Object.entries(sources);
  if (!entries.length) return null;
  return (
    <p className="srcline">
      {entries.map(([p, s]) => (
        <span key={p} className="srcline__item" title={s.detail ?? ''}>
          <span className={classNames('sdot', s.state === 'ok' ? 'sdot--ok' : s.state === 'skipped' ? '' : 'sdot--warn')} aria-hidden="true" />
          {PROVIDER_LABEL[p] ?? p}
          {s.state === 'ok' ? ` · ${s.count ?? 0}` : s.state === 'skipped' ? ' · skipped' : ' · unavailable'}
        </span>
      ))}
    </p>
  );
}

function TrackList({ tracks, seedKeys, onAdd, onPreview, onDownload, label }: { tracks: Track[]; seedKeys: Set<string>; onAdd: (t: Track) => void; onPreview: (t: Track) => void; onDownload?: (t: Track) => void; label: string }) {
  return (
    <ul className="well tracks" aria-label={label}>
      {tracks.map((t) => {
        const added = seedKeys.has(t.key);
        const meta = [t.album, fmtRelease(t.release)].filter(Boolean).join(' · ');
        return (
          <li key={`${t.provider}:${t.platform_id}`} className={classNames('track', added && 'is-added')}>
            <Art src={t.artwork} size={44} />
            <div className="track__text">
              <span className="track__title">
                {t.title}
                {(t.versions ?? (t.version ? [t.version] : [])).map((v) => (
                  <span key={v} className="vtag">
                    {v}
                  </span>
                ))}
              </span>
              <span className="track__artist">{artistOf(t)}</span>
              {meta && <span className="track__meta">{meta}</span>}
              {t.warning && <span className="track__warn">{t.warning}</span>}
            </div>
            <span className="track__dur">{fmtDuration(t.duration)}</span>
            <span className="track__src" title={`From ${PROVIDER_LABEL[t.provider] ?? t.provider}`}>
              <ProviderMark provider={markKey(t.provider)} size={14} />
              <span className="track__srcname">{PROVIDER_LABEL[t.provider] ?? t.provider}</span>
            </span>
            <span className="track__actions">
              {(t.preview || t.provider === 'ytmusic' || t.provider === 'soundcloud') && (
                <button className="iconbtn" type="button" onClick={() => onPreview(t)} aria-label={`Play ${t.title}`} title="Play">
                  <Glyph name="play" size={14} />
                </button>
              )}
              {onDownload && (
                <button className="iconbtn" type="button" onClick={() => onDownload(t)} aria-label={`Download ${t.title}`} title="Download">
                  <Glyph name="download" size={14} />
                </button>
              )}
              {t.url && (
                <a className="iconbtn" href={t.url} target="_blank" rel="noreferrer noopener" aria-label={`Open ${t.title} in ${PROVIDER_LABEL[t.provider] ?? t.provider}`} title={`Open in ${PROVIDER_LABEL[t.provider] ?? t.provider}`}>
                  <Glyph name="share" size={14} />
                </a>
              )}
              <button className={classNames('push', 'addbtn', added && 'is-on')} type="button" onClick={() => onAdd(t)} disabled={added} aria-label={added ? `${t.title} is a starting song` : `Add ${t.title} to your starting songs`}>
                {added ? (
                  <>
                    <Glyph name="check" size={12} /> Added
                  </>
                ) : (
                  'Add'
                )}
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
