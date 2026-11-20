import { describe, expect, it } from 'vitest';
import { publisherBroadcast } from './radio-feeds';
import type { RadioStation } from './radio';

// RADIO-IHEART-META-001 (owner, 2026-11-20): "ensure the iheart stations get updated data properly and accurately".
// Stations from iHeart's directory are often streamed by other hosts (B96 and WBBM by Audacy's amperwave, K-LOVE by
// EMF), yet iHeart's own song feed knows what is playing on them. The feed is asked by the iHeart station id.
const now = 1795165300000;
const st = (id: string, url: string): RadioStation => ({ id, name: 'B96', url, homepage: '', image: '', country: 'The United States Of America', countryCode: 'US', region: 'Illinois', language: 'english', tags: [], codec: 'AAC', bitrate: 64, latitude: null, longitude: null });
const track = JSON.stringify({ title: 'Shabang', artist: 'Drake', album: 'ICEMAN', trackDuration: 188, imagePath: 'http://image.iheart.com/x/583f.jpg', startTime: 1795165214316, endTime: 1795165402629 });

describe('iHeart song feed for every iHeart-directory station', () => {
  it('a station from iHeart\'s directory streamed by another host asks iHeart\'s feed by its id', async () => {
    const asked: string[] = [];
    const b = await publisherBroadcast(st('ihr-10823', 'https://live.amperwave.net/direct/audacy-wbbmfmaac-imc'), async (u) => { asked.push(u); return track; }, now);
    expect(asked[0]).toBe('https://us.api.iheart.com/api/v3/live-meta/stream/10823/currentTrackMeta?defaultMetadata=true');
    expect(b).toMatchObject({ artist: 'Drake', title: 'Shabang', state: 'current', kind: 'song', source: 'iHeart official feed', startedAt: 1795165214316, duration: 188 });
  });
  it('no answer from iHeart falls through to the station host\'s own feed (Power 92: Futuri)', async () => {
    const asked: string[] = [];
    const b = await publisherBroadcast(st('ihr-12904', 'https://ais-sa8.cdnstream1.com/pptsa5hdbog/cjo5jxmng7u'), async (u) => {
      asked.push(u);
      if (u.includes('iheart.com')) return '';
      return JSON.stringify([{ TIT2: 'WTF GOIN', TPE1: 'Belly Gang Kushington', played_on: (now - 60000) / 1000, last_seen: (now - 5000) / 1000 }]);
    }, now);
    expect(asked).toHaveLength(2);
    expect(b).toMatchObject({ artist: 'Belly Gang Kushington', source: 'Futuri official feed' });
  });
  it('a finished track from the feed is not shown as current', async () => {
    const old = JSON.stringify({ title: 'Old', artist: 'A', startTime: now - 400000, endTime: now - 100000 });
    const b = await publisherBroadcast(st('ihr-10823', 'https://live.amperwave.net/direct/audacy-wbbmfmaac-imc'), async () => old, now);
    expect(b?.title).not.toBe('Old');
  });
  it('a Radio Browser row merged with an iHeart station asks the feed by its iHeart id', async () => {
    const asked: string[] = [];
    await publisherBroadcast({ ...st('5020fbf7', 'https://live.amperwave.net/direct/audacy-wxrtfmaac-imc'), iheartId: '10844' }, async (u) => { asked.push(u); return track; }, now);
    expect(asked[0]).toBe('https://us.api.iheart.com/api/v3/live-meta/stream/10844/currentTrackMeta?defaultMetadata=true');
  });
  it('a Radio Browser station never asks iHeart', async () => {
    const asked: string[] = [];
    await publisherBroadcast(st('5020fbf7-712b-41a9-9560-8be3fcb56935', 'https://live.amperwave.net/direct/audacy-wbbmfmaac-imc'), async (u) => { asked.push(u); return ''; }, now);
    expect(asked.some((u) => u.includes('iheart'))).toBe(false);
  });
});
