import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Glyph, ProviderMark } from '@now-playing/aqua-ui/icons';
import { api, ApiError, type Evidence, type IdentifyResponse, type PlaylistSummary, type ResolveResponse, type SearchResponse, type SourceState, type Track } from './api';
import { Art } from './Art';
import { SaveMenu } from './SaveMenu';
import { PROVIDER_LABEL, artistOf, classNames, fmtDuration, fmtRelease, looksLikeUrl, markKey } from './util';

/** What a result row's like button needs, shared by every list of results (SEARCH-LIKE-001). */
interface LikeProps {
  /** Teach the algorithm. Called with false when the like is taken back. */
  onLike?: (t: Track, like: boolean) => void;
  onRemoveSeed?: (t: Track) => void;
  lists?: PlaylistSummary[];
  onLists?: (lists: PlaylistSummary[]) => void;
  /**
   * Which song's list menu is open, held above the rows. Liking a song makes it a starting song,
   * which changes state in the app above and remounts these rows: a menu kept inside a row closed
   * itself the moment it opened (observed on the Windows app).
   */
  saving?: string | null;
  onSaving?: (songKey: string | null) => void;
  /**
   * QUEUE-ADD-001: the row's add button, in place of the link that opened the song on its own service.
   * It puts the song into what the listener is listening to: `addLabel` names it (the now playing
   * queue, or a list), and `addedKeys` are the songs already there.
   */
  onQueueAdd?: ((t: Track) => void) | undefined;
  addLabel?: string | undefined;
  addedKeys?: ReadonlySet<string> | undefined;
}

/** SEARCH-QUEUE-001: Play hands over the whole list the row is in, so the skip buttons walk it. */
type PlayFrom = (t: Track, list: Track[]) => void;

interface Props extends LikeProps {
  /** SRC-BUDGET-001: opens Settings, where the daily download allowance is set. */
  onOpenSettings?: (() => void) | undefined;
  seeds: Track[];
  onAdd: (t: Track) => void;
  onPreview: PlayFrom;
  onDownload?: (t: Track) => void;
}

type Origin = 'lyrics' | 'audio';
type HelpCode = 'denied' | 'no_mic' | 'mic_failed' | 'no_capture' | 'unsupported' | 'unreadable' | 'too_long' | 'short' | 'busy' | 'offline' | 'budget' | 'refused' | 'failed';
type AudioPhase = 'permission' | 'listening' | 'reading' | 'analysing';
/** The lyric half of a plain-text search, which arrives after (and independently of) the title half. */
type LyricPart = { state: 'pending' } | { state: 'ok'; tracks: Track[]; named: number; unplayable: number } | { state: 'failed'; code: string };

type View =
  | { kind: 'idle' }
  | { kind: 'loading'; what: 'search' | 'link' }
  | { kind: 'results'; tracks: Track[]; sources: Record<string, SourceState>; query: string; ms: number; lyrics?: LyricPart | undefined }
  | { kind: 'identified'; origin: Origin; tracks: Track[]; query: string; named: number; unplayable: number; heard?: { title: string; artist: string } | undefined }
  | { kind: 'audio'; phase: AudioPhase; name?: string; elapsed?: number; level?: number; device?: string; quiet?: boolean }
  | { kind: 'help'; code: HelpCode; origin: Origin; detail?: string | undefined }
  | { kind: 'choice'; res: Extract<ResolveResponse, { kind: 'choice' }> }
  | { kind: 'error'; message: string };

const AUTOCOMPLETE_MS = 450;
// On a phone the engine runs on the device, so the pause after the last key can be shorter.
const AUTOCOMPLETE_PHONE_MS = 250;
// Genius is slower and more rate limited than the catalogues, so typing-time lyric lookups start a little after the title ones.
const LYRIC_LAG_MS = 250;
const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 30;
const MIN_CLIP_S = 3;
const LIMIT_S = 12;
const AUDIO_ACCEPT = '.mp3,.m4a,.aac,.wav,.ogg,.oga,.opus,.flac,.webm,audio/*';

const isAndroid = (): boolean => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
const fmtClock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';
const offline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;
// Loaded on first use of File or Mic, so the fingerprint code stays out of the startup bundle.
const listen = () => import('./engine/listen');

/**
 * Whether the words are enough to ask Genius while the person is still typing. One word matches half the
 * catalogue, so a live lyric search waits for two words.
 */
export function liveLyricsReady(text: string): boolean {
  const t = text.trim();
  return t.length >= 8 && t.split(/\s+/).filter(Boolean).length >= 2;
}

/**
 * Which half of a plain-text answer leads. Four words or more is a line of a song, so its lyric matches go
 * first; a short query is almost always a title or an artist.
 */
export function lyricsLead(query: string, lyricMatches: number): boolean {
  return lyricMatches > 0 && query.trim().split(/\s+/).filter(Boolean).length >= 4;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (window.clearTimeout(t), reject(new DOMException('Aborted', 'AbortError'))), { once: true });
  });

const NARROW = '(max-width: 480px)';
function useNarrow(): boolean {
  const [m, setM] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

/**
 * The one prominent field. Whatever is typed is understood without a mode switch:
 *  - A music link is resolved (on Enter, on Search or when pasted).
 *  - Anything else searches titles on the live providers, and from two words on also asks Genius which songs
 *    contain those words. Both run as you type (debounced) and at once on Enter; the title answer shows as soon
 *    as it lands and the lyric matches join it.
 *  - Live results never blank the list: the last answer stays, dimmed, until the next one lands.
 *  - File / Mic: up to 12 s is fingerprinted on the device; only the fingerprint goes to Shazam.
 * A newer request aborts the older one. Searching or identifying is never a preference signal: only Add makes a starting song.
 */
export function Search({ seeds, onAdd, onPreview, onDownload, onLike, onRemoveSeed, lists, onLists, onQueueAdd, addLabel, addedKeys, onOpenSettings }: Props) {
  const [saving, setSaving] = useState<string | null>(null);
  const likeProps: LikeProps = { onLike, onRemoveSeed, lists, onLists, saving, onSaving: setSaving, onQueueAdd, addLabel, addedKeys };
  const [q, setQ] = useState('');
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [artistFix, setArtistFix] = useState('');
  /** A newer answer is on its way; the list on screen is the previous one. */
  const [refreshing, setRefreshing] = useState(false);
  const narrow = useNarrow();
  const kind = useRef<View['kind']>('idle');
  const cache = useRef(new Map<string, { at: number; view: View }>());
  const ctl = useRef<AbortController | null>(null);
  const timer = useRef<number | null>(null);
  const rec = useRef<{ stop(): void; cancel(): void } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const micBtn = useRef<HTMLButtonElement>(null);
  const fileBtn = useRef<HTMLButtonElement>(null);
  const stopBtn = useRef<HTMLButtonElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const bars = useRef<HTMLSpanElement>(null);
  const initiator = useRef<'mic' | 'file' | null>(null);
  const seedKeys = new Set(seeds.map((s) => s.key));
  const busyAudio = view.kind === 'audio';
  const phase: AudioPhase | null = view.kind === 'audio' ? view.phase : null;
  kind.current = view.kind;

  const cancel = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    ctl.current?.abort();
    ctl.current = null;
    rec.current?.cancel();
    rec.current = null;
    setRefreshing(false);
  };

  const fresh = (): AbortController => {
    cancel();
    const c = new AbortController();
    ctl.current = c;
    return c;
  };

  const showIdentified = (r: IdentifyResponse, origin: Origin) =>
    setView({ kind: 'identified', origin, tracks: r.results, query: r.query, named: r.named ?? 0, unplayable: r.unplayable ?? 0, heard: r.heard });

  /** Maps a failed Genius/Shazam call to copy. Nothing retries on its own. */
  const failService = (e: unknown, c: AbortController, origin: Origin) => {
    if (c.signal.aborted || isAbort(e)) return;
    setRefreshing(false);
    const code = e instanceof ApiError ? (e.body as { code?: string } | null)?.code : undefined;
    if (code === 'busy' || code === 'offline' || code === 'budget' || code === 'refused') setView({ kind: 'help', code, origin });
    else if (offline()) setView({ kind: 'help', code: 'offline', origin });
    else setView({ kind: 'help', code: 'failed', origin, detail: e instanceof Error ? e.message : String(e) });
  };

  /** Shows a finished answer and remembers it, so backspacing to an earlier phrase is instant and costs no request. */
  const land = (key: string, v: View) => {
    const c = cache.current;
    c.delete(key);
    c.set(key, { at: Date.now(), view: v });
    while (c.size > CACHE_MAX) c.delete(c.keys().next().value as string);
    setView(v);
    setRefreshing(false);
  };

  /** Starts a request. A list already on screen stays (dimmed) instead of giving way to "Searching…". */
  const begin = (what: 'search' | 'link') => {
    if (kind.current === 'results' || kind.current === 'identified') setRefreshing(true);
    else setView({ kind: 'loading', what });
  };

  /** `force` skips the remembered answer: SRC-REFRESH-001 asks every source again. */
  const run = async (text: string, live = false, force = false) => {
    const s = text.trim();
    if (!s) {
      cancel();
      setView({ kind: 'error', message: 'Enter a title, artist, some lyrics or a music link.' });
      return;
    }
    const link = looksLikeUrl(s);
    const key = s.toLowerCase().replace(/\s+/g, ' ');
    const hit = cache.current.get(key);
    if (hit && !link && !force && Date.now() - hit.at < CACHE_MS) {
      cancel();
      setView(hit.view);
      return;
    }
    const c = fresh();
    begin(link ? 'link' : 'search');
    try {
      if (link) {
        const r = await api.resolve(s, c.signal);
        if (c.signal.aborted) return;
        if (r.kind === 'track') setView({ kind: 'results', tracks: [r.track], sources: { [r.track.provider]: { state: 'ok', count: 1, ms: r.ms } }, query: s, ms: r.ms });
        else if (r.kind === 'choice') setView({ kind: 'choice', res: r });
        else setView({ kind: 'error', message: r.message });
        setRefreshing(false);
        return;
      }
      // Titles and lyrics are asked together. Neither waits for the other to be shown, and a failed half never hides the other.
      let songs: SearchResponse | null = null;
      let lyrics: LyricPart | undefined = liveLyricsReady(s) && !offline() ? { state: 'pending' } : undefined;
      const show = (final: boolean) => {
        if (c.signal.aborted) return;
        const v: View = { kind: 'results', tracks: songs?.results ?? [], sources: songs?.sources ?? {}, query: s, ms: songs?.ms ?? 0, lyrics };
        if (final && lyrics?.state !== 'failed') land(key, v);
        else {
          setView(v);
          setRefreshing(false);
        }
      };
      const songsP = api.search(s, c.signal).then((r) => {
        songs = r;
        if (lyrics?.state === 'pending') show(false);
      });
      const lyricsP = lyrics
        ? (live ? wait(LYRIC_LAG_MS, c.signal) : Promise.resolve()).then(() => api.searchLyrics(s, c.signal)).then(
            (r) => {
              lyrics = { state: 'ok', tracks: r.results, named: r.named ?? 0, unplayable: r.unplayable ?? 0 };
            },
            (e) => {
              if (c.signal.aborted || isAbort(e)) return;
              lyrics = { state: 'failed', code: e instanceof ApiError ? ((e.body as { code?: string } | null)?.code ?? 'failed') : 'failed' };
            },
          )
        : Promise.resolve();
      const [sr] = await Promise.allSettled([songsP, lyricsP]);
      if (c.signal.aborted) return;
      if (sr.status === 'rejected' && (isAbort(sr.reason) || (lyrics as LyricPart | undefined)?.state !== 'ok')) throw sr.reason;
      show(true);
    } catch (e) {
      if (c.signal.aborted || isAbort(e)) return;
      setRefreshing(false);
      // A search made while typing that fails keeps the list it had; only one the person asked for says it failed.
      if (live && (kind.current === 'results' || kind.current === 'identified')) return;
      setView({ kind: 'error', message: e instanceof ApiError ? e.message : 'The discovery server did not answer. Is it running?' });
    }
  };

  /** Fingerprint on the device, then ask Shazam about the fingerprint only. */
  const identify = async (samples: Float32Array, c: AbortController) => {
    const L = await listen();
    if (c.signal.aborted) return;
    if (samples.length < MIN_CLIP_S * L.SAMPLE_RATE) return setView({ kind: 'help', code: 'short', origin: 'audio' });
    if (offline()) return setView({ kind: 'help', code: 'offline', origin: 'audio' });
    setView({ kind: 'audio', phase: 'analysing' });
    try {
      const sig = await L.makeSignature(L.pickWindow(samples), c.signal);
      if (c.signal.aborted) return;
      // Silence has too few peaks to match: say so instead of sending it.
      if (L.peakCount(sig) < 20) return setView({ kind: 'identified', origin: 'audio', tracks: [], query: '', named: 0, unplayable: 0 });
      const r = await api.identifyAudio(L.signatureUri(sig), L.signatureMillis(sig), c.signal);
      if (!c.signal.aborted) showIdentified(r, 'audio');
    } catch (e) {
      failService(e, c, 'audio');
    }
  };

  const captureFailed = (e: unknown, c: AbortController, from: 'mic' | 'file') => {
    if (c.signal.aborted || isAbort(e)) return;
    const code = (e as { code?: string } | null)?.code ?? '';
    if (code === 'cancelled') return;
    const map: Record<string, HelpCode> = { denied: 'denied', no_mic: 'no_mic', mic_failed: 'mic_failed', unreadable: 'unreadable', too_long: 'too_long', unsupported: from === 'mic' ? 'no_capture' : 'unsupported' };
    setView({ kind: 'help', code: map[code] ?? (from === 'mic' ? 'mic_failed' : 'unreadable'), origin: 'audio', detail: e instanceof Error ? e.message : String(e) });
  };

  const startMic = async () => {
    const c = fresh();
    initiator.current = 'mic';
    setView({ kind: 'audio', phase: 'permission' });
    try {
      const L = await listen();
      let loudest = 0;
      const r = await L.recordMic((elapsed, level) => {
        loudest = Math.max(loudest, level);
        // 2.5 s of nothing at all means the wrong microphone or a muted one: say so while there is still time to switch
        if (!c.signal.aborted) setView((v) => (v.kind === 'audio' && v.phase === 'listening' ? { ...v, elapsed, level, quiet: elapsed >= 2.5 && loudest < 0.08 } : v));
      }, c.signal, (bands, peak) => {
        // straight to the DOM: re-rendering React 60 times a second for 24 bars would cost more than the sound it draws
        const el = bars.current;
        if (!el) return;
        let top = 0;
        for (let i = 0; i < bands.length; i++) {
          const v = bands[i]!;
          if (v > top) top = v;
          (el.children[i] as HTMLElement | undefined)?.style.setProperty('--h', String(Math.max(0.08, v)));
        }
        panel.current?.style.setProperty('--lvl', (peak < L.SILENT_PEAK ? 0 : top).toFixed(3));
      });
      if (c.signal.aborted) return r.cancel();
      rec.current = r;
      setView({ kind: 'audio', phase: 'listening', elapsed: 0, level: 0, device: r.device });
      const samples = await r.done;
      rec.current = null;
      await identify(samples, c);
    } catch (e) {
      rec.current = null;
      captureFailed(e, c, 'mic');
    }
  };

  const startFile = async (file: File | undefined) => {
    if (!file) return;
    const c = fresh();
    initiator.current = 'file';
    setView({ kind: 'audio', phase: 'reading', name: file.name });
    try {
      const L = await listen();
      const samples = await L.samplesFromFile(file, c.signal);
      if (!c.signal.aborted) await identify(samples, c);
    } catch (e) {
      captureFailed(e, c, 'file');
    }
  };

  const stopAudio = () => {
    cancel();
    setView({ kind: 'idle' });
  };

  const onChange = (v: string) => {
    setQ(v);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    const t = v.trim();
    if (!t) {
      cancel();
      setView({ kind: 'idle' });
    } else if (t.length >= 3 && !looksLikeUrl(t)) {
      timer.current = window.setTimeout(() => void run(t, true), narrow ? AUTOCOMPLETE_PHONE_MS : AUTOCOMPLETE_MS);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(q);
  };

  useEffect(() => cancel, []);

  // No hidden listening: leaving the app (Android home, switching away on Windows) discards a capture in progress.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && rec.current) {
        cancel();
        setView({ kind: 'idle' });
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  // Focus goes to Stop when listening starts (which also closes the Android keyboard), to Cancel while reading or
  // identifying, and back to the button that started it when the panel closes. Results are announced, never focused.
  useEffect(() => {
    if (phase === 'listening') stopBtn.current?.focus();
    else if (phase === 'reading' || phase === 'analysing') {
      const a = document.activeElement;
      if (!a || a === document.body || panel.current?.contains(a)) cancelBtn.current?.focus();
    } else if (!phase && initiator.current) {
      const a = document.activeElement;
      if (!a || a === document.body) (initiator.current === 'file' ? fileBtn.current : micBtn.current)?.focus();
      initiator.current = null;
    }
  }, [phase]);

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

  const label = 'Search by song, artist, lyrics or music link';
  // The full sentence does not fit inside the phone's bar; the accessible label stays complete.
  const placeholder = !narrow ? label : 'Song, lyrics or link';

  return (
    <section
      className={'search'}
      aria-label="Find songs"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && busyAudio) {
          e.preventDefault();
          stopAudio();
        }
      }}
    >
      <form className={classNames('search__form', q && 'has-text')} role="search" onSubmit={submit}>
        <label className="sr" htmlFor="q">
          {label}
        </label>
        <span className="search__field">
          <span className="search__icon" aria-hidden="true">
            {view.kind === 'loading' || refreshing ? <span className="search__spin" /> : <Glyph name="search" size={16} />}
          </span>
          <input
            ref={input}
            id="q"
            className="field"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={q}
            disabled={busyAudio}
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
              if (e.key === 'Escape' && q && !busyAudio) {
                e.preventDefault();
                setQ('');
                cancel();
                setView({ kind: 'idle' });
              }
            }}
            aria-describedby="q-hint q-privacy"
          />
          {/* Shown while there is text: clears the field and the results, and puts the cursor back. */}
          <button
            className="search__clear"
            type="button"
            aria-label="Clear search"
            disabled={busyAudio}
            onClick={() => {
              setQ('');
              cancel();
              setView({ kind: 'idle' });
              input.current?.focus();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          <span className="find__acts">
            <button ref={fileBtn} className="find__act find__act--file" type="button" disabled={busyAudio} onClick={() => fileInput.current?.click()} aria-label="Identify a song from an audio file" title="Identify a song from an audio file">
              <FolderGlyph />
            </button>
            <button ref={micBtn} className="find__act find__act--mic" type="button" disabled={busyAudio} onClick={() => void startMic()} aria-label="Identify a song with the microphone" title="Identify a song with the microphone">
              <MicGlyph />
            </button>
          </span>
        </span>
        <input
          ref={fileInput}
          className="sr"
          type="file"
          tabIndex={-1}
          aria-hidden="true"
          accept={AUDIO_ACCEPT}
          onChange={(e) => {
            void startFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </form>
      <p id="q-hint" className="search__hint">
        Type a title, an artist, a line you remember from the lyrics, or paste a music link. Results update as you type.
      </p>
      <p id="q-privacy" className="search__hint">
        Audio is fingerprinted on your device; only fingerprints go to Shazam, and lyric words go to Genius.
      </p>

      <div className={classNames(refreshing && 'is-refreshing')} aria-live="polite" aria-busy={view.kind === 'loading' || refreshing || busyAudio}>
        {view.kind === 'loading' && (
          <p className="state">
            <span className="sdot sdot--busy" aria-hidden="true" />
            {view.what === 'link' ? 'Reading the link…' : 'Searching…'}
          </p>
        )}
        {view.kind === 'audio' && (
          <div className="listen" ref={panel}>
            <span className={classNames('listen__pulse', view.phase === 'listening' && 'is-live')} aria-hidden="true">
              {view.phase === 'reading' ? <FolderGlyph size={20} /> : <MicGlyph size={20} />}
            </span>
            <div className="listen__now">
              <p className="listen__label">
                {view.phase === 'permission'
                  ? 'Waiting for microphone permission…'
                  : view.phase === 'listening'
                    ? 'Listening. Stops after 12 seconds.'
                    : view.phase === 'reading'
                      ? `Reading “${view.name ?? 'your file'}”…`
                      : 'Identifying your clip…'}
              </p>
              {view.phase === 'listening' && (
                <span className="listen__bars" ref={bars} aria-hidden="true">
                  {Array.from({ length: 24 }, (_, i) => (
                    <span key={i} className="listen__bar" />
                  ))}
                </span>
              )}
              {view.phase === 'listening' && (
                <span className="listen__row" aria-hidden="true">
                  <span className="listen__meter" title="Microphone level">
                    <span className="listen__level" style={{ transform: `scaleX(${Math.max(0.03, view.level ?? 0)})` }} />
                  </span>
                  <span className="listen__time">
                    {fmtClock(view.elapsed ?? 0)} / {fmtClock(LIMIT_S)}
                  </span>
                </span>
              )}
              {view.phase === 'reading' && <span className="listen__sub">Uses 12 seconds from the middle of the file.</span>}
              {view.phase === 'listening' && view.quiet && (
                <span className="listen__sub listen__sub--warn" role="status">
                  Not hearing anything{view.device ? ` on ${view.device}` : ''}. Choose another microphone under Settings, or check it is not muted.
                </span>
              )}
              {view.phase === 'listening' && !view.quiet && view.device && <span className="listen__sub">Using {view.device}</span>}
            </div>
            <span className="listen__actions">
              {view.phase === 'listening' && (
                <button ref={stopBtn} className="push push--default" type="button" onClick={() => rec.current?.stop()} aria-label="Stop listening and identify">
                  Stop
                </button>
              )}
              <button ref={cancelBtn} className="push" type="button" onClick={stopAudio} aria-label="Cancel identification">
                Cancel
              </button>
            </span>
          </div>
        )}
        {view.kind === 'help' && <Help code={view.code} origin={view.origin} detail={view.detail} onRetry={view.origin === 'lyrics' ? () => void run(q) : undefined} />}
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
            {view.res.tracks.length > 0 && <TrackList tracks={view.res.tracks} seedKeys={seedKeys} onAdd={onAdd} onPreview={onPreview} onDownload={onDownload} {...likeProps} label="Choose a song" />}
          </div>
        )}
        {view.kind === 'results' && (
          <ResultsView view={view} seedKeys={seedKeys} onAdd={onAdd} onPreview={onPreview} onDownload={onDownload} {...likeProps} onRefresh={() => void run(view.query, false, true)} refreshing={refreshing} onOpenSettings={onOpenSettings} />
        )}
        {view.kind === 'identified' && (
          <IdentifiedView view={view} seedKeys={seedKeys} onAdd={onAdd} onPreview={onPreview} onDownload={onDownload} {...likeProps} />
        )}
      </div>
    </section>
  );
}

const LYRIC_NOTE: Record<string, string> = {
  busy: 'Genius is busy, so lyric matches are missing. Keep typing or press Search to try again.',
  offline: 'No connection for the lyric search.',
  budget: 'Today’s download allowance is all used up, so lyrics were not searched.',
  refused: 'Genius refused the lyric search.',
};

/** Title results and lyric matches for one plain-text query, in the order that suits the query. */
function ResultsView({
  view,
  seedKeys,
  onAdd,
  onPreview,
  onDownload,
  onLike,
  onRemoveSeed,
  lists,
  onLists,
  saving,
  onSaving,
  onQueueAdd,
  addLabel,
  addedKeys,
  onRefresh,
  refreshing = false,
  onOpenSettings,
}: {
  view: Extract<View, { kind: 'results' }>;
  seedKeys: Set<string>;
  onAdd: (t: Track) => void;
  onPreview: PlayFrom;
  onDownload?: ((t: Track) => void) | undefined;
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean | undefined;
  onOpenSettings?: (() => void) | undefined;
} & LikeProps) {
  const lyr = view.lyrics;
  const titleKeys = new Set(view.tracks.map((t) => t.key));
  const lyricTracks = lyr?.state === 'ok' ? lyr.tracks.filter((t) => !titleKeys.has(t.key)) : [];
  const lead = lyricsLead(view.query, lyricTracks.length);
  const common = { seedKeys, onAdd, onPreview, onDownload, onLike, onRemoveSeed, lists, onLists, saving, onSaving, onQueueAdd, addLabel, addedKeys } as const;
  const spent = Object.values(view.sources).some((x) => x.state === 'budget');
  // Asking again cannot help when every source that did not answer was refused for the allowance.
  const canRefresh = !Object.values(view.sources).every((x) => x.state === 'ok' || x.state === 'skipped' || x.state === 'budget') || !spent;

  const titles = view.tracks.length ? (
    <div key="titles">
      <SourceLine sources={view.sources} onRefresh={canRefresh ? onRefresh : undefined} refreshing={refreshing} />
      {spent && <BudgetNote onOpenSettings={onOpenSettings} />}
      <TrackList tracks={view.tracks} {...common} label={`Results for ${view.query}`} />
    </div>
  ) : null;

  const lyricBlock = lyricTracks.length ? (
    <div key="lyrics">
      <p className="srcline">
        <span className="srcline__item">
          <span className="sdot sdot--ok" aria-hidden="true" />
          Lyrics matched via Genius. {lyricTracks.length === 1 ? '1 match found.' : `${lyricTracks.length} matches found.`}
          {lyr?.state === 'ok' && lyr.unplayable > 0 ? ` ${lyr.unplayable} more ${lyr.unplayable === 1 ? 'is' : 'are'} not on a service Airwave plays from.` : ''}
        </span>
      </p>
      <TrackList tracks={lyricTracks} {...common} label={`Songs with the words ${view.query}`} />
    </div>
  ) : null;

  const blocks = lead ? [lyricBlock, titles] : [titles, lyricBlock];
  const none = !view.tracks.length && !lyricTracks.length;

  return (
    <>
      {blocks}
      {lyr?.state === 'pending' && (
        <p className="state">
          <span className="sdot sdot--busy" aria-hidden="true" />
          Checking lyrics…
        </p>
      )}
      {lyr?.state === 'failed' && (
        <p className="state" role="status">
          <Glyph name="info" size={14} /> {LYRIC_NOTE[lyr.code] ?? 'The lyric search failed.'}
        </p>
      )}
      {none && lyr?.state !== 'pending' && spent && !(lyr?.state === 'ok' && lyr.named > 0) && (
        <>
          <p className="state">No songs found for “{view.query}”.</p>
          <BudgetNote onOpenSettings={onOpenSettings} />
        </>
      )}
      {none && lyr?.state !== 'pending' && !(spent && !(lyr?.state === 'ok' && lyr.named > 0)) && (
        <p className="state">
          {lyr?.state === 'ok' && lyr.named > 0
            ? `No songs found for “${view.query}”. Genius found songs with these words, but none is on a service Airwave plays from.`
            // SRC-WARN-001: which provider was quiet is reported in Settings, not here. The listener
            // still gets the actionable half - an incomplete run is worth retrying.
            : `No songs found for “${view.query}”.${Object.values(view.sources).some((x) => x.state !== 'ok') ? ' The search ran short; try again in a moment.' : ' Try the artist and title together, or a different line of the lyrics.'}`}
          {onRefresh && canRefresh && Object.values(view.sources).some((x) => x.state !== 'ok') && <RefreshSources onRefresh={onRefresh} refreshing={refreshing} />}
        </p>
      )}
    </>
  );
}

function IdentifiedView({
  view,
  seedKeys,
  onAdd,
  onPreview,
  onDownload,
  onLike,
  onRemoveSeed,
  lists,
  onLists,
  saving,
  onSaving,
  onQueueAdd,
  addLabel,
  addedKeys,
}: {
  view: Extract<View, { kind: 'identified' }>;
  seedKeys: Set<string>;
  onAdd: (t: Track) => void;
  onPreview: PlayFrom;
  onDownload?: ((t: Track) => void) | undefined;
} & LikeProps) {
  const n = view.tracks.length;
  if (!n) {
    let text: string;
    if (view.origin === 'audio' && view.heard) text = `Shazam heard “${view.heard.title}” by ${view.heard.artist}, but it is not on a service Airwave plays from. Try searching for it by title.`;
    else if (view.named > 0) text = 'Genius found songs with these words, but none is on a service Airwave plays from. Try a different line.';
    else if (view.origin === 'lyrics') text = 'No lyric match found. Try a different line or fewer words.';
    else text = 'No match found in this clip. Try a clearer section with music playing, or search by title or lyrics.';
    return <p className="state">{text}</p>;
  }
  const more = view.unplayable > 0 ? ` ${view.unplayable} more ${view.unplayable === 1 ? 'is' : 'are'} not on a service Airwave plays from.` : '';
  return (
    <>
      <p className="srcline">
        <span className="srcline__item">
          <span className="sdot sdot--ok" aria-hidden="true" />
          {view.origin === 'lyrics' ? 'Lyrics matched via Genius.' : 'Audio identified via Shazam.'} {n === 1 ? '1 match found.' : `${n} matches found.`} Use Play to hear it, or Like to keep it and teach the algorithm.{more}
        </span>
      </p>
      <TrackList
        tracks={view.tracks}
        seedKeys={seedKeys}
        onAdd={onAdd}
        onPreview={onPreview}
        onDownload={onDownload}
        onLike={onLike}
        onRemoveSeed={onRemoveSeed}
        lists={lists}
        onLists={onLists}
        saving={saving}
        onSaving={onSaving}
        onQueueAdd={onQueueAdd}
        addLabel={addLabel}
        addedKeys={addedKeys}
        label={view.origin === 'lyrics' ? `Songs with the words ${view.query}` : 'Songs heard in your clip'}
      />
    </>
  );
}

const HELP: Record<HelpCode, { title: string; body: string }> = {
  denied: { title: 'Microphone access is off.', body: '' },
  no_mic: { title: 'No microphone found.', body: 'Connect or turn on a microphone and try again, or choose an audio file.' },
  mic_failed: { title: 'The microphone could not start.', body: 'Check that no other app is using it, then try again.' },
  no_capture: { title: 'The microphone is not available here.', body: 'Choose an audio file instead.' },
  unsupported: { title: 'That is not an audio file this app can read.', body: 'Choose an MP3, M4A, WAV, OGG, FLAC or WebM file.' },
  unreadable: { title: 'This file could not be read.', body: 'It may be damaged or use an unsupported codec. Try another MP3, M4A, WAV, OGG, FLAC or WebM file.' },
  too_long: { title: 'This file is too large to read here.', body: 'Trim it to a short clip and choose it again.' },
  short: { title: 'That clip was too short.', body: 'Let it listen for at least 3 seconds while the music plays.' },
  busy: { title: 'Shazam is busy.', body: 'Wait a moment, then try again.' },
  offline: { title: 'You are offline.', body: 'Connect to the internet, then try again.' },
  budget: { title: 'Today’s download allowance is all used up.', body: 'It resets tomorrow, or raise it in Settings.' },
  refused: { title: 'Shazam refused the request.', body: 'The service may have changed. Search by title or lyrics instead.' },
  failed: { title: 'Identification failed.', body: 'Try again, or search by title.' },
};

function Help({ code, origin, detail, onRetry }: { code: HelpCode; origin: Origin; detail?: string | undefined; onRetry?: (() => void) | undefined }) {
  let title = HELP[code].title;
  let body: ReactNode = HELP[code].body;
  if (origin === 'lyrics') {
    if (code === 'busy') title = 'Genius is busy.';
    if (code === 'failed') title = 'The lyrics search failed.';
    if (code === 'refused') {
      title = 'Genius refused the request.';
      body = 'The service may have changed. Search by title instead.';
    }
  }
  if (code === 'denied') {
    body = isAndroid()
      ? 'Allow it in Android Settings → Apps → Airwave Discovery → Permissions → Microphone, then try again. You can also choose an audio file.'
      : 'Turn on “Microphone access” and “Let desktop apps access your microphone” in Windows Settings → Privacy & security → Microphone, then try again.';
  }
  return (
    <div className="find__help" role="status">
      <p className="find__help-title">
        <Glyph name="warning" size={14} /> {title}
      </p>
      <p className="find__help-body">
        {body}
        {code === 'failed' && detail ? <span className="find__help-detail"> ({detail})</span> : null}
      </p>
      {onRetry && (code === 'busy' || code === 'offline' || code === 'failed') && (
        <button className="push" type="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** aqua-ui has no microphone glyph; drawn here on the same 24-unit grid, in currentColor. */
function FolderGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg className="find__glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4.1c.6 0 1.2.25 1.6.7l1.4 1.5h5.9A2.5 2.5 0 0 1 21 8.7v8.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
    </svg>
  );
}

function MicGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg className="find__glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M12 14.5a3.5 3.5 0 0 0 3.5-3.5V5.5a3.5 3.5 0 0 0-7 0V11a3.5 3.5 0 0 0 3.5 3.5zm6.3-3.6h-1.9a4.4 4.4 0 0 1-8.8 0H5.7a6.3 6.3 0 0 0 5.35 6.2V20H8v2h8v-2h-3.05v-2.9a6.3 6.3 0 0 0 5.35-6.2z" />
    </svg>
  );
}

/**
 * SRC-REFRESH-001: ask every source again, now, for the words on screen. A source shown as unavailable
 * only failed that one request, and the search remembers an answer for five minutes, so retyping the
 * words showed the same failure. The list stays, dimmed, until the new answer lands.
 */
function RefreshSources({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) {
  return (
    <button
      className={classNames('iconbtn', 'srcline__refresh', refreshing && 'is-busy')}
      type="button"
      onClick={onRefresh}
      disabled={refreshing}
      aria-busy={refreshing}
      aria-label="Refresh sources"
      title="Ask every source again"
    >
      <Glyph name="refresh" size={14} />
    </button>
  );
}

/**
 * SRC-BUDGET-001. Owner: say the allowance was all used up. The sources were refused before being asked
 * because today's download allowance (Settings) is spent; it resets tomorrow.
 */
function BudgetNote({ onOpenSettings }: { onOpenSettings?: (() => void) | undefined }) {
  return (
    // The button gets its own row: inside the flex .state line it was squeezed beside the text and
    // its label ran out of the button and off a 390px screen.
    <div className="budget-note" role="status">
      <p className="state">
        <Glyph name="info" size={14} /> Today’s download allowance is all used up, so those sources could not be asked. It resets tomorrow.
      </p>
      {onOpenSettings && (
        <button className="push" type="button" onClick={onOpenSettings} aria-label="Raise the allowance in Settings">
          Raise the allowance in Settings
        </button>
      )}
    </div>
  );
}

function SourceLine({ sources, onRefresh, refreshing = false }: { sources: Record<string, SourceState>; onRefresh?: (() => void) | undefined; refreshing?: boolean }) {
  const entries = Object.entries(sources);
  if (!entries.length) return null;
  // The labels wrap in their own group and the refresh sits beside it, so a 44px button never makes
  // one wrapped row taller than the others (seen at 390px: an uneven gap above the last row).
  const items = entries.map(([p, s]) => (
        <span key={p} className="srcline__item" title={s.detail ?? ''}>
          <span className={classNames('sdot', s.state === 'ok' ? 'sdot--ok' : s.state === 'skipped' ? '' : 'sdot--warn')} aria-hidden="true" />
          {PROVIDER_LABEL[p] ?? p}
          {s.state === 'ok' ? ` · ${s.count ?? 0}` : s.state === 'skipped' ? ' · skipped' : s.state === 'budget' ? ' · allowance used up' : ' · unavailable'}
        </span>
  ));
  if (!onRefresh) return <p className="srcline">{items}</p>;
  return (
    <div className="srcline srcline--refresh">
      <p className="srcline__items">{items}</p>
      <RefreshSources onRefresh={onRefresh} refreshing={refreshing} />
    </div>
  );
}

/** The matching lyric lines with the matched words in <mark>; line breaks shown as " / ". Plain text, never provider HTML. */
export function LyricSnippet({ snippet, ranges }: { snippet: string; ranges: [number, number][] }) {
  const parts: ReactNode[] = [];
  const plain = (t: string) => t.replace(/\s*\n\s*/g, ' / ');
  let at = 0;
  [...ranges]
    .sort((a, b) => a[0] - b[0])
    .forEach(([a, b], i) => {
      if (a < at || b <= a || b > snippet.length) return;
      if (a > at) parts.push(plain(snippet.slice(at, a)));
      parts.push(<mark key={i}>{plain(snippet.slice(a, b))}</mark>);
      at = b;
    });
  if (at < snippet.length) parts.push(plain(snippet.slice(at)));
  return <>“{parts}”</>;
}

function EvidenceLine({ e }: { e: Evidence }) {
  if (e.kind === 'lyrics') {
    return (
      <span className="track__evidence track__evidence--quote">
        <LyricSnippet snippet={e.snippet} ranges={e.ranges} />
      </span>
    );
  }
  return <span className="track__evidence">Heard in your clip{typeof e.offset === 'number' ? ` · ${fmtClock(e.offset)} into the song` : ''}</span>;
}

export function TrackList({
  tracks,
  seedKeys,
  onAdd,
  onPreview,
  onDownload,
  onLike,
  onRemoveSeed,
  lists,
  onLists,
  saving: savingProp,
  onSaving,
  onQueueAdd,
  addLabel = 'Now playing queue',
  addedKeys,
  label,
}: {
  tracks: Track[];
  seedKeys: Set<string>;
  onAdd: (t: Track) => void;
  onPreview: PlayFrom;
  onDownload?: ((t: Track) => void) | undefined;
  /** Teach the algorithm. Called with false when the like is taken back (SEARCH-LIKE-001). */
  onLike?: ((t: Track, like: boolean) => void) | undefined;
  onRemoveSeed?: ((t: Track) => void) | undefined;
  lists?: PlaylistSummary[] | undefined;
  onLists?: ((lists: PlaylistSummary[]) => void) | undefined;
  saving?: string | null | undefined;
  onSaving?: ((songKey: string | null) => void) | undefined;
  onQueueAdd?: ((t: Track) => void) | undefined;
  addLabel?: string | undefined;
  addedKeys?: ReadonlySet<string> | undefined;
  label: string;
}) {
  // Controlled by Search when it is in charge; the row's own state only when it stands alone.
  const [ownSaving, setOwnSaving] = useState<string | null>(null);
  const saving = onSaving ? (savingProp ?? null) : ownSaving;
  const setSaving = onSaving ?? setOwnSaving;
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
              {t.evidence && <EvidenceLine e={t.evidence} />}
              {t.warning && <span className="track__warn">{t.warning}</span>}
            </div>
            <span className="track__dur">{fmtDuration(t.duration)}</span>
            <span className="track__src" title={`From ${PROVIDER_LABEL[t.provider] ?? t.provider}`}>
              <ProviderMark provider={markKey(t.provider)} size={14} />
              <span className="track__srcname">{PROVIDER_LABEL[t.provider] ?? t.provider}</span>
            </span>
            <span className="track__actions">
              {/*
                NP-ALWAYS-001: every row offers Play. It used to appear only for a row that carried a
                preview or came from YouTube Music or SoundCloud — so the owner's "BATMAN" row had no
                Play button at all, on a song the player could have found and downloaded. The player
                knows how to look a song up, and how to download it when no player here can play it;
                the row's job is to ask.
              */}
              <button className="iconbtn" type="button" onClick={() => onPreview(t, tracks)} aria-label={`Play ${t.title}`} title="Play">
                <Glyph name="play" size={14} />
              </button>
              {onDownload && (
                <button className="iconbtn" type="button" onClick={() => onDownload(t)} aria-label={`Download ${t.title}`} title="Download">
                  <Glyph name="download" size={14} />
                </button>
              )}
              {/* QUEUE-ADD-001: the owner replaced the link out to the song's own service with this. */}
              {onQueueAdd && (() => {
                const inIt = addedKeys?.has(t.key) ?? false;
                return (
                  <button
                    className={classNames('iconbtn', inIt && 'is-on')}
                    type="button"
                    aria-pressed={inIt}
                    onClick={() => { if (!inIt) onQueueAdd(t); }}
                    aria-label={inIt ? `${t.title} is in ${addLabel}` : `Add ${t.title} to ${addLabel}`}
                    title={inIt ? `In ${addLabel}` : `Add to ${addLabel}`}
                  >
                    <Glyph name={inIt ? 'check' : 'playlist-add'} size={14} />
                  </button>
                );
              })()}
              {/* SEARCH-LIKE-001: the song list's like button, in place of the old Add pill. One press
                  teaches the algorithm, keeps the song as a starting song, and offers the lists. */}
              <button
                className={classNames('iconbtn', added && 'is-on')}
                type="button"
                aria-pressed={added}
                aria-expanded={onLists ? saving === t.key : undefined}
                onClick={() => {
                  if (added) {
                    onLike?.(t, false);
                    onRemoveSeed?.(t);
                    setSaving(null);
                    return;
                  }
                  onLike?.(t, true);
                  onAdd(t);
                  if (onLists) setSaving(t.key);
                }}
                aria-label={added ? `Remove like from ${t.title}` : `Like ${t.title} and choose lists`}
                title={added ? 'Liked — a starting song' : 'Like and choose lists'}
              >
                <Glyph name="thumb-up" size={14} />
              </button>
            </span>
            {saving === t.key && onLists && (
              <div className="track__savemenu">
                <SaveMenu songKey={t.key} title={t.title} lists={lists ?? []} onLists={onLists} onClose={() => setSaving(null)} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
