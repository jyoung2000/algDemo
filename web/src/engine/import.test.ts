/** History importers: public-format fixtures, deterministic ids, honest confidence. */
import { describe, expect, it } from 'vitest';
import { detectFormat, parseHistoryFile, parseListenBrainz, parseSpotifyExtended, IMPORT_CAP } from './import';

const spotifyRow = (over: Record<string, unknown> = {}) => ({
  ts: '2026-06-01T12:00:00Z',
  ms_played: 215000,
  master_metadata_track_name: 'Get Lucky',
  master_metadata_album_artist_name: 'Daft Punk',
  reason_end: 'trackdone',
  skipped: false,
  ...over,
});

const lbListen = (over: Record<string, unknown> = {}) => ({
  listened_at: 1750000000,
  track_metadata: { track_name: 'Get Lucky', artist_name: 'Daft Punk', ...((over['track_metadata'] as object) ?? {}) },
  ...over,
});

describe('spotify extended history', () => {
  it('trackdone becomes a confident-ish complete with real listened seconds', () => {
    const s = parseSpotifyExtended([spotifyRow()]);
    expect(s.usable).toBe(1);
    const e = s.events[0]!;
    expect(e.kind).toBe('complete');
    expect(e.listened).toBe(215);
    expect(e.confidence).toBe(0.8);
    expect(e.origin).toBe('import:spotify');
    expect(e.ts).toBe(Math.floor(Date.parse('2026-06-01T12:00:00Z') / 1000)); // original time kept
    expect(e.key).toContain('daft punk');
  });

  it('a quick fwdbtn is a skip; ambiguous end reasons are dropped, not guessed', () => {
    const s = parseSpotifyExtended([
      spotifyRow({ ms_played: 4000, reason_end: 'fwdbtn', skipped: true }),
      spotifyRow({ ms_played: 90000, reason_end: 'backbtn' }),
      spotifyRow({ ms_played: 90000, reason_end: 'logout' }),
    ]);
    expect(s.usable).toBe(1);
    expect(s.events[0]!.kind).toBe('skip');
    expect(s.dropped.find((d) => d.reason.includes('proves neither'))?.count).toBe(2);
  });

  it('podcast rows (no track metadata) are dropped with a named reason', () => {
    const s = parseSpotifyExtended([spotifyRow({ master_metadata_track_name: null })]);
    expect(s.usable).toBe(0);
    expect(s.dropped[0]!.reason).toContain('podcast');
  });

  it('re-parsing the same file yields the same event ids (idempotent import)', () => {
    const a = parseSpotifyExtended([spotifyRow()]).events[0]!.event_id;
    const b = parseSpotifyExtended([spotifyRow()]).events[0]!.event_id;
    expect(a).toBe(b);
  });
});

describe('listenbrainz export', () => {
  it('a listen is qualified, not a completion; listened seconds remain unknown', () => {
    const s = parseListenBrainz({ listens: [lbListen()] });
    expect(s.usable).toBe(1);
    const e = s.events[0]!;
    expect(e.kind).toBe('qualified');
    expect(e.listened).toBeNull();
    expect(e.confidence).toBe(0.6);
    expect(e.ts).toBe(1750000000);
  });

  it('accepts both bare arrays and {listens: []} shapes', () => {
    expect(parseListenBrainz([lbListen()]).usable).toBe(1);
    expect(parseListenBrainz({ listens: [lbListen()] }).usable).toBe(1);
  });
});

describe('format detection and caps', () => {
  it('detects both formats and rejects garbage', () => {
    expect(detectFormat([spotifyRow()])).toBe('spotify');
    expect(detectFormat([lbListen()])).toBe('listenbrainz');
    expect(detectFormat({ foo: 1 })).toBeNull();
    expect(() => parseHistoryFile('not json')).toThrow(/Invalid JSON\/JSONL/);
    expect(() => parseHistoryFile('{"foo":1}')).toThrow(/Unrecognised/);
  });

  it('accepts extracted ListenBrainz JSON Lines from an export ZIP', () => {
    const text = `${JSON.stringify(lbListen())}\n${JSON.stringify(lbListen({ listened_at: 1750000100 }))}\n`;
    const s = parseHistoryFile(text);
    expect(s.source).toBe('listenbrainz');
    expect(s.usable).toBe(2);
  });

  it('caps at the newest IMPORT_CAP events and says so', () => {
    const rows = Array.from({ length: IMPORT_CAP + 50 }, (_, i) =>
      spotifyRow({ ts: new Date(1700000000000 + i * 3600_000).toISOString(), master_metadata_track_name: `Song ${i}` }),
    );
    const s = parseSpotifyExtended(rows);
    expect(s.usable).toBe(IMPORT_CAP);
    expect(s.dropped.find((d) => d.reason.includes('newest'))?.count).toBe(50);
    // newest first: the kept set starts at the highest timestamp
    expect(s.events[0]!.ts).toBeGreaterThan(s.events[s.events.length - 1]!.ts);
  });
});
