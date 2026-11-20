import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GapWindow, normalizeStation, parseBroadcast, radioErrorText } from './radio';

// RADIO-ROBUST-001 (owner, 2026-11-20): "Ensure all radio stations ... seamlessly works on Android". A sweep of the 147
// Chicago-area stations on the phone found these.
describe('a station plays from an address that still works', () => {
  it('a playlist link wins over the directory\'s resolved address, which can be a one-time session (WGN 720)', () => {
    const s = normalizeStation({ stationuuid: 'w', name: 'WGN 720', url: 'http://stream.abacast.net/playlist/wgnam-wgnammp3-ibc2.m3u', url_resolved: 'http://18.204.34.32/wgnam-wgnammp3-ibc2?session-id=5a45db', country: 'US' })!;
    expect(s.url).toBe('http://stream.abacast.net/playlist/wgnam-wgnammp3-ibc2.m3u');
    for (const p of ['https://x.example/live.pls', 'https://x.example/a/listen.m3u?x=1', 'https://x.example/hls/playlist.m3u8'])
      expect(normalizeStation({ stationuuid: 'p', name: 'P', url: p, url_resolved: 'https://cdn.example/stream', country: 'US' })!.url).toBe(p);
  });
  it('a plain stream link still uses the resolved address (it follows the directory\'s redirect check)', () => {
    expect(normalizeStation({ stationuuid: 'k', name: 'KEXP', url: 'https://kexp.org/listen', url_resolved: 'https://kexp.streamguys1.com/kexp160.aac', country: 'US' })!.url).toBe('https://kexp.streamguys1.com/kexp160.aac');
  });
});

describe('a station that cannot play says why, in plain words', () => {
  it('names an offline stream, a station that does not answer, a dropped stream and undecodable audio', () => {
    expect(radioErrorText('Station answered HTTP 404')).toBe('This station\'s stream is offline right now (HTTP 404). Try another station.');
    expect(radioErrorText('failed to connect to /18.204.34.32 (port 80) after 8000ms')).toBe('The station did not answer. Try again, or pick another station.');
    expect(radioErrorText('read interrupted')).toBe('The station did not answer. Try again, or pick another station.');
    expect(radioErrorText('Read timed out')).toBe('The station did not answer. Try again, or pick another station.');
    expect(radioErrorText('Unable to resolve host "x.example": No address associated with hostname')).toBe('The station did not answer. Try again, or pick another station.');
    expect(radioErrorText('Station disconnected')).toBe('The station stopped sending audio. Reconnect to try again.');
    expect(radioErrorText('Radio decoder stopped')).toBe('This station\'s audio could not be played. Try another station.');
    expect(radioErrorText('Encrypted broadcasts are not supported')).toBe('Encrypted broadcasts are not supported');
    expect(radioErrorText(null)).toBeNull();
  });
  it('the player shows the plain words', () => {
    const src = readFileSync(resolve(process.cwd(), 'src', 'RadioPlayer.tsx'), 'utf8');
    expect(src).toMatch(/\{r\.error \? <>\{radioErrorText\(r\.error\)\} <button/);
  });
});

describe('ad markers are not songs', () => {
  it('Audacy streams (NewsRadio 780) send "ad|main - Commercial Break - <banner link>" during ads', () => {
    const b = parseBroadcast('ad|main - Commercial Break - https://d3d86ekqlyggds.cloudfront.net/banner/1/1/147814/0/9223/0/0/banner.html?bid=147814', 'Broadcaster ICY');
    expect(b.state).toBe('unavailable');
    expect(parseBroadcast('ad|preroll - Sponsor', 'ICY').state).toBe('unavailable');
    expect(parseBroadcast('Commercial Break - Spot 3', 'ICY').state).toBe('unavailable');
    expect(parseBroadcast('Drake - Shabang', 'ICY')).toMatchObject({ state: 'current', artist: 'Drake', title: 'Shabang' });
    expect(parseBroadcast('Breakbot - Commercial Breakdown', 'ICY').state).toBe('current'); // a song that merely says it
  });
});

describe('BEHIND LIVE does not flicker on stations that send audio in bursts (Power 92)', () => {
  it('judges the gap by its largest value over the last 3 s', () => {
    const g = new GapWindow();
    // 5 s behind after a pause; between bursts the measured gap dips to 3.6 s, then a burst lifts it back
    expect(g.add(1000, 6.4)).toBe(6.4);
    expect(g.add(2000, 3.6)).toBe(6.4);
    expect(g.add(3500, 5.1)).toBe(6.4);
    expect(g.add(4500, 3.7)).toBe(5.1); // 6.4 has left the window
    expect(g.add(8000, 1.2)).toBe(1.2); // back at live, it says so within 3 s
  });
  it('starts again for a new session', () => {
    const g = new GapWindow(); g.add(0, 20); g.reset(); expect(g.add(10, 1)).toBe(1);
  });
  it('the player uses it', () => {
    const src = readFileSync(resolve(process.cwd(), 'src', 'RadioPlayer.tsx'), 'utf8');
    expect(src).toMatch(/const gap = snap \? gaps\.current\.add\(Date\.now\(\), Math\.max\(0, snap\.received - snap\.position\)\) : 0;/);
  });
});
