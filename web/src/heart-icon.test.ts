// HEART-ICON-001 (owner, 2026-11-22): "change the star icon to a heart icon everywhere in the app and in android auto".
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const sources = readdirSync(dir).filter((f) => /\.tsx$/.test(f) && !/\.test\./.test(f));

describe('no screen of the app draws a star', () => {
  it('uses the heart glyphs wherever a star was drawn', () => {
    const drawn: string[] = [];
    for (const f of sources) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      if (/name=["{][^>]*'?star(-filled)?['"]/.test(src) || /[★☆]/.test(src)) drawn.push(f);
    }
    expect(drawn).toEqual([]);
  });
  it('the car\u2019s like, artist and station buttons are hearts too', () => {
    const res = new URL('../../android/app/src/main/res/drawable/', import.meta.url);
    const heart = /M12,21\.35l-1\.45,-1\.32/;
    for (const f of ['car_star_add.xml', 'car_star_artist.xml', 'car_station_fav.xml', 'car_station_fav_on.xml']) {
      expect(readFileSync(new URL(f, res), 'utf8'), f).toMatch(heart);
    }
    const service = readFileSync(new URL('../../android/app/src/main/java/com/nowplaying/discovery/PlaybackService.kt', import.meta.url), 'utf8');
    expect(service).not.toMatch(/ICON_STAR/);
    expect(service).toMatch(/if \(starred\) CommandButton\.ICON_HEART_FILLED else CommandButton\.ICON_HEART_UNFILLED/);
    // The station's favourite is not the same picture as the song's heart.
    expect(service).toMatch(/if \(favourite\) R\.drawable\.car_station_fav_on else R\.drawable\.car_station_fav\)/);
  });
});
