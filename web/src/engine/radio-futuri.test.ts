import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { publisherBroadcast } from './radio-feeds';
import { normalizeStation } from './radio';

// RADIO-FEED-FUTURI-001 (owner, 2026-11-19): "power92 is not accurately and quickly updating the song, its actually going
// back to the previous song". Power 92's stream (Futuri DAS, ais-sa8.cdnstream1.com) sends its ICY title only at connect,
// so each 20 s probe could carry an old item ("Stephane Hirondelle - Electro City"). The station's own player reads
// yp.cdnstream1.com/metadata/<mount>/current.json, which names the song on air and when it started.
const power92 = normalizeStation({ stationuuid: 'ihr-12904', name: 'Power 92', url_resolved: 'https://ais-sa8.cdnstream1.com/pptsa5hdbog/cjo5jxmng7u', country: 'US' })!;
const now = 1795143654000;
const feed = JSON.stringify([{ TALB: '', TIT2: 'WTF GOIN (feat. 21 Savage)', TPE1: 'Belly Gang Kushington', WXXX_album_art: 'https://img.example.com/a.jpg', last_seen: 1795143628.36, played_on: 1795143628.36 }]);

describe('Futuri (cdnstream1) now-playing feed', () => {
  it('reads the song on air and its start time from the station mount', async () => {
    const asked: string[] = [];
    const b = await publisherBroadcast(power92, async (u) => { asked.push(u); return u.includes('iheart.com') ? '' : feed; }, now);
    // iHeart's feed is asked first (RADIO-IHEART-META-001); it names nothing for Power 92, so the station's own feed answers
    expect(asked).toEqual(['https://us.api.iheart.com/api/v3/live-meta/stream/12904/currentTrackMeta?defaultMetadata=true', 'https://yp.cdnstream1.com/metadata/pptsa5hdbog/cjo5jxmng7u/current.json']);
    expect(b).toMatchObject({ artist: 'Belly Gang Kushington', state: 'current', kind: 'song', source: 'Futuri official feed', startedAt: 1795143628360, artwork: 'https://img.example.com/a.jpg' });
    expect(b!.title).toMatch(/^WTF GOIN/);
  });
  it('an empty or stale feed is no answer (the stream title is tried next)', async () => {
    expect(await publisherBroadcast(power92, async () => '[]', now)).toBeNull();
    const old = JSON.stringify([{ TIT2: 'Echo', TPE1: 'R.Kelly', played_on: (now - 40 * 60000) / 1000, last_seen: (now - 30 * 60000) / 1000 }]);
    expect(await publisherBroadcast(power92, async () => old, now)).toBeNull();
  });
  it('the player asks for what is playing every 5 s (RADIO-TITLE-INBAND-001; it was 10 s, and 20 s before that)', () => {
    const src = readFileSync(resolve(process.cwd(), 'src', 'engine', 'radio-client.ts'), 'utf8');
    expect(src).toMatch(/export const RADIO_META_EVERY_MS = 5000;/);
    expect(src.match(/setInterval\(\(\) => void this\.refreshMetadata\(gen\), RADIO_META_EVERY_MS\)/g)).toHaveLength(2);
    expect(src).toMatch(/const b = await stationMetadata\(s, false, RADIO_META_EVERY_MS - 500\)/);
  });
});
