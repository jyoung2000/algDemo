import { describe, expect, it } from 'vitest';
import { publisherBroadcast, tritonCue, icecastBroadcast } from './radio-feeds';
import { normalizeStation, parseBroadcast, freshBroadcast } from './radio';
import { buildFeedback2 } from './engine';
import { collapseRows } from './taste2';
import { ListenMeter } from '../util';
const s = (url: string) => normalizeStation({ stationuuid: 'a', name: 'Untrusted name', url_resolved: url, country: 'GB' })!;
describe('original Airwave + Hub radio metadata parity', () => {
  it('rejects advertising cues, understands iHeart M cues and fixed-width padding', () => {
    expect(parseBroadcast(' - Advertisement', 'ICY').state).toBe('unavailable');
    expect(parseBroadcast('Artist - text="Spot Block" song_spot="T"', 'ICY').state).toBe('unavailable');
    expect(parseBroadcast('Artist - text="Track" song_spot="M"', 'ICY')).toMatchObject({ artist: 'Artist', title: 'Track', kind: 'song' });
    expect(parseBroadcast(' - Fiesta! with Elbio Barilari -  -  - ', 'ICY')).toMatchObject({ kind: 'programme', title: 'Fiesta! with Elbio Barilari', artist: null });
  });
  it('does not select a broadcaster feed by a directory name', async () => {
    const called: string[] = [];
    expect(await publisherBroadcast({ ...s('https://other.example/live'), name: 'SomaFM KEXP' }, async u => { called.push(u); return '{}'; })).toBeNull(); expect(called).toEqual([]);
  });
  it('reads SomaFM from the stream mount, retaining its real cue timestamp', async () => {
    const b = await publisherBroadcast(s('https://ice6.somafm.com/groovesalad-128-mp3'), async u => { expect(u).toBe('https://somafm.com/songs/groovesalad.json'); return JSON.stringify({ songs: [{ artist: 'A', title: 'B', date: 100 }] }); }, 100000);
    expect(b).toMatchObject({ artist: 'A', title: 'B', startedAt: 100000 });
  });
  it('reads Triton history rather than presenting heartbeat time as song start', () => {
    const cue = (title: string, start: number) => `<nowplaying-info><property name="cue_title"><![CDATA[${title}]]></property><property name="track_artist_name"><![CDATA[Artist]]></property><property name="cue_time_start"><![CDATA[${start}]]></property><property name="cue_time_duration"><![CDATA[200000]]></property></nowplaying-info>`;
    const b = tritonCue(cue('Song', 12000) + cue('Song', 5000) + cue('Previous', 1000), 20000)!;
    expect(b.startedAt).toBe(5000); expect(b.duration).toBe(200);
    expect(freshBroadcast(b, 300000).state).toBe('stale');
  });
  it('requires an Icecast mount match, never shows a different station on the same host', async () => {
    const get = async () => JSON.stringify({ icestats: { source: [{ listenurl: 'http://stream.test/other', title: 'Wrong - Song' }, { listenurl: 'http://stream.test/live', title: 'Right - Song' }] } });
    expect(await icecastBroadcast(s('https://stream.test/live'), get)).toMatchObject({ artist: 'Right', title: 'Song' });
    expect(await icecastBroadcast(s('https://stream.test/missing'), get)).toBeNull();
  });
});
describe('radio does not corrupt music taste', () => {
  it('excludes starred programmes but learns a qualified, recognized music listen', () => {
    const base = { event_id: 'p', kind: 'like', key: 'radio:a:p', ts: 100, artist: 'News Station', track: { title: 'Morning News', artist: 'News Station', kind: 'radio-programme' } };
    const e = { ...base, event_id: 'song', kind: 'qualified', key: 'artist|song', artist: 'Artist', listened: 45, coverage: 45, medium: 'radio', track: { title: 'Song', artist: 'Artist' } };
    const f = buildFeedback2([base, e], 100); expect(f.track['radio:a:p']).toBeUndefined(); expect(f.track['artist|song']).toBeGreaterThan(0);
    expect(collapseRows([base, e])).toEqual([e]);
  });
  it('counts unique content actually played, not pausing or repeated rewinds', () => {
    const m = new ListenMeter(); for (let i = 0; i <= 20; i++) m.tick(i, true); const unique = m.coverage;
    for (let i = 20; i < 40; i++) m.tick(20, false); expect(m.coverage).toBe(unique);
    m.seeked(10); for (let i = 11; i <= 20; i++) m.tick(i, true); expect(m.coverage).toBe(unique);
  });
});

describe('publisher timeline and programme cover data (RADIO-PLAYER-002)', () => {
  const now = Date.parse('2026-11-16T18:30:00Z');
  it('retains KEXP airdate and publisher image rather than losing them in title parsing', async () => {
    const b = await publisherBroadcast(s('https://kexp.streamguys1.com/kexp160.aac'), async () => JSON.stringify({ results: [{ artist: 'Artist', song: 'Song', airdate: '2026-11-16T18:28:00Z', image_uri: 'https://www.kexp.org/cover.jpg' }] }), now);
    expect(b).toMatchObject({ startedAt: now - 120000, artwork: 'https://www.kexp.org/cover.jpg' });
    expect(b?.duration).toBeFalsy(); // the API did not publish a duration
  });
  it('uses both ends of a BBC programme window for the actual duration', async () => {
    const id = 'bbc_radio_fourfm';
    const b = await publisherBroadcast(s('https://stream.live.vc.bbcmedia.co.uk/' + id), async () => JSON.stringify({ service: { id }, items: [{ service: { id }, brand: { title: 'Evening News' }, published_time: { start: '2026-11-16T18:00:00Z', end: '2026-11-16T19:00:00Z' } }] }), now);
    expect(b).toMatchObject({ kind: 'programme', startedAt: now - 1800000, duration: 3600, validUntil: now + 1800000 });
  });
  it('rejects private artwork URLs rather than presenting them to the browser', async () => {
    const b = await publisherBroadcast(s('https://kexp.streamguys1.com/kexp160.aac'), async () => JSON.stringify({ results: [{ artist: 'Artist', song: 'Song', airdate: '2026-11-16T18:28:00Z', image_uri: 'http://127.0.0.1/private.png' }] }), now);
    expect(b?.artwork).toBeFalsy();
  });
});
