/**
 * Optional local history importers (Spotify extended streaming history, ListenBrainz export).
 *
 * Everything stays local: the user picks a file, it is parsed here, and each listen becomes a
 * normal feedback event POSTed to the engine (which deduplicates by event id). Imported events:
 *  - keep their ORIGINAL timestamps (taste decay sees the real age, not the import day);
 *  - carry origin 'import:<source>' and a sub-1 confidence (exports prove less than live
 *    telemetry: ListenBrainz proves a submitted listen, not completion; Spotify's reason_end
 *    is self-reported by one client);
 *  - get deterministic event ids from content, so re-importing the same file is a no-op;
 *  - never manufacture a duration/completion ratio the file does not contain.
 */
import { recordingKey, splitArtists } from './identity';

export interface ImportedEvent {
  event_id: string;
  key: string;
  kind: 'complete' | 'skip' | 'qualified';
  artist: string;
  title: string;
  ts: number;
  listened: number | null;
  origin: string;
  confidence: number;
}

export interface ImportSummary {
  source: 'spotify' | 'listenbrainz';
  total: number; // rows in the file
  usable: number; // rows that became events
  dropped: { reason: string; count: number }[];
  events: ImportedEvent[];
}

/** Most recent events kept per import; decay makes ancient history nearly weightless anyway. */
export const IMPORT_CAP = 2000;

/** FNV-1a; stable, tiny, good enough for content-derived event ids (not security). */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const keyOf = (title: string, artist: string): string => recordingKey(title, [artist]);
const primaryOf = (artist: string): string => splitArtists([artist])[0] ?? '';

/** Spotify extended streaming history: an array of objects with ts/ms_played/master_metadata_*. */
export function parseSpotifyExtended(rows: unknown[]): ImportSummary {
  const events: ImportedEvent[] = [];
  const dropped = new Map<string, number>();
  const drop = (r: string) => dropped.set(r, (dropped.get(r) ?? 0) + 1);
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const title = r['master_metadata_track_name'];
    const artist = r['master_metadata_album_artist_name'];
    if (typeof title !== 'string' || !title || typeof artist !== 'string' || !artist) {
      drop('not a music track (podcast, or missing metadata)');
      continue;
    }
    const ts = Date.parse(String(r['ts'] ?? ''));
    if (!Number.isFinite(ts)) {
      drop('unreadable timestamp');
      continue;
    }
    const ms = Number(r['ms_played']);
    const played = Number.isFinite(ms) ? Math.max(0, ms / 1000) : null;
    const reason = String(r['reason_end'] ?? '');
    const skipped = r['skipped'] === true;
    // trackdone = the client says the track finished; fwdbtn/skipped with a short play = a skip.
    // Everything else (backbtn, logout, remote, unknown) proves neither and is left out.
    let kind: 'complete' | 'skip';
    if (reason === 'trackdone') kind = 'complete';
    else if ((skipped || reason === 'fwdbtn') && played !== null && played < 30) kind = 'skip';
    else {
      drop('end reason proves neither completion nor a deliberate skip');
      continue;
    }
    const tsSec = Math.floor(ts / 1000);
    events.push({
      event_id: `imp-sp-${fnv(`${tsSec}|${title}|${artist}|${kind}`)}`,
      key: keyOf(title, artist),
      kind,
      artist: primaryOf(artist),
      title,
      ts: tsSec,
      listened: played,
      origin: 'import:spotify',
      confidence: kind === 'complete' ? 0.8 : 0.6,
    });
  }
  return finish('spotify', rows.length, events, dropped);
}

/** ListenBrainz export: { listens: [...] } or a bare array of { listened_at, track_metadata }. */
export function parseListenBrainz(doc: unknown): ImportSummary {
  const rows: unknown[] = Array.isArray(doc)
    ? doc
    : Array.isArray((doc as Record<string, unknown>)?.['listens'])
      ? ((doc as Record<string, unknown>)['listens'] as unknown[])
      : detectFormat(doc) === 'listenbrainz' ? [doc] : [];
  const events: ImportedEvent[] = [];
  const dropped = new Map<string, number>();
  const drop = (r: string) => dropped.set(r, (dropped.get(r) ?? 0) + 1);
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const meta = (r['track_metadata'] ?? {}) as Record<string, unknown>;
    const title = meta['track_name'];
    const artist = meta['artist_name'];
    const ts = Number(r['listened_at']);
    if (typeof title !== 'string' || !title || typeof artist !== 'string' || !artist) {
      drop('missing track or artist name');
      continue;
    }
    if (!Number.isFinite(ts) || ts <= 0) {
      drop('unreadable timestamp');
      continue;
    }
    // A submitted listen is evidence of a play, never proof of duration or completion.
    // Keep the two unknowns separate, rather than labelling it a full-track completion.
    events.push({
      event_id: `imp-lb-${fnv(`${Math.floor(ts)}|${title}|${artist}`)}`,
      key: keyOf(title, artist),
      kind: 'qualified',
      artist: primaryOf(artist),
      title,
      ts: Math.floor(ts),
      listened: null,
      origin: 'import:listenbrainz',
      confidence: 0.6,
    });
  }
  return finish('listenbrainz', rows.length, events, dropped);
}

/** Sniff which export a parsed JSON document is; null when it is neither. */
export function detectFormat(doc: unknown): 'spotify' | 'listenbrainz' | null {
  if (Array.isArray(doc) && doc.length) {
    const first = doc[0] as Record<string, unknown>;
    if ('ms_played' in first || 'master_metadata_track_name' in first) return 'spotify';
    if ('listened_at' in first || 'track_metadata' in first) return 'listenbrainz';
  }
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    const row = doc as Record<string, unknown>;
    if (Array.isArray(row['listens']) || ('listened_at' in row && 'track_metadata' in row)) return 'listenbrainz';
  }
  return null;
}

export function parseHistoryFile(text: string): ImportSummary {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // ListenBrainz exports `listens/<year>/<month>.jsonl` inside a ZIP: one listen per line.
    // Ask for the extracted month file, never upload the archive. A corrupt row aborts before
    // anything is persisted, rather than silently omitting a person's history.
    const lines = text.split(/\r?\n/).filter((s) => s.trim());
    if (!lines.length) throw new Error('Empty history file. Select an extracted Spotify JSON or ListenBrainz .jsonl file.');
    try {
      const rows = lines.map((line) => JSON.parse(line) as unknown);
      if (detectFormat(rows) === 'listenbrainz') return parseListenBrainz(rows);
    } catch {
      throw new Error('Invalid JSON/JSONL history file. Extract the ListenBrainz ZIP and select a .jsonl month file.');
    }
    throw new Error('Unrecognised file: expected Spotify extended streaming history JSON or ListenBrainz listens/*.jsonl.');
  }
  const fmt = detectFormat(doc);
  if (fmt === 'spotify') return parseSpotifyExtended(doc as unknown[]);
  if (fmt === 'listenbrainz') return parseListenBrainz(doc);
  throw new Error('Unrecognised file: expected Spotify extended streaming history JSON or ListenBrainz listens/*.jsonl.');
}

function finish(source: 'spotify' | 'listenbrainz', total: number, events: ImportedEvent[], dropped: Map<string, number>): ImportSummary {
  // within one import, the same event id can repeat (same song finished twice in a second — some
  // exports double-log); keep the first
  const seen = new Set<string>();
  let unique = events.filter((e) => (seen.has(e.event_id) ? false : (seen.add(e.event_id), true)));
  unique.sort((a, b) => b.ts - a.ts);
  if (unique.length > IMPORT_CAP) {
    dropped.set(`older than the newest ${IMPORT_CAP} (decay makes them nearly weightless)`, unique.length - IMPORT_CAP);
    unique = unique.slice(0, IMPORT_CAP);
  }
  return {
    source,
    total,
    usable: unique.length,
    dropped: [...dropped.entries()].map(([reason, count]) => ({ reason, count })),
    events: unique,
  };
}
