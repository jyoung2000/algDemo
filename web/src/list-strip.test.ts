import { describe, expect, it } from 'vitest';
import { listStrip, listTaste } from './list-strip';
import { gradientOf, soundView } from './taste-view';
import { genreIdentity } from './engine/genre-identity';
import { familyColor } from './engine/genre-palette';

/**
 * LIST-STRIP-001: a saved or imported list's colour strip comes from its songs' stated tags, through
 * the Sound card's own mapping (soundView + gradientOf) - no second colour table.
 */
const T = (name: string, over: Record<string, unknown> = {}) => ({ name, label: name, source: 'Deezer album genre', scope: 'album', confidence: 0.8, inferred: false, ...over });
const track = (...tags: ReturnType<typeof T>[]) => ({ tags });

describe('the per-list colour mix', () => {
  it('is empty and honest when no song has a genre yet', () => {
    const s = listStrip([track(), track(), null]);
    expect(s.gradient).toBeNull();
    expect(s.songs).toBe(2);
    expect(s.placed).toBe(0);
    expect(s.label).toBe('No genres known yet');
    expect(listStrip([]).label).toBe('No songs yet');
  });

  it('counts each song once and each canonical genre once per song', () => {
    const { taste, songs, placed } = listTaste([track(T('hip-hop'), T('hip-hop'), T('rage')), track(T('hip-hop')), track()]);
    expect(songs).toBe(3);
    expect(placed).toBe(2);
    const by = Object.fromEntries((taste!.genres ?? []).map((g) => [g.name, g.plays]));
    expect(by).toEqual({ 'hip-hop': 2, rage: 1 });
  });

  it('ignores estimated tags, so the strip only shows what a service stated', () => {
    expect(listStrip([track(T('pop', { inferred: true }))]).gradient).toBeNull();
  });

  it('draws exactly the Sound card gradient for the same songs, in the Taste Picker colours', () => {
    const tracks = [track(T('hip-hop'), T('rage')), track(T('r&b'))];
    const s = listStrip(tracks);
    const view = soundView(listTaste(tracks).taste)!;
    expect(s.gradient).toBe(gradientOf(view.bar));
    // The R&B family colour the Taste Picker uses is one of the strip's stops.
    const rnb = genreIdentity('R&B')!.color;
    expect(s.gradient).toContain(rnb);
    expect(view.families.map((f) => f.color)).toContain(familyColor('rnb-afro-latin'));
    expect(s.label).toMatch(/%/);
  });

  it('fills in as tags arrive: more tagged songs change the mix', () => {
    const before = listStrip([track(T('hip-hop')), track()]);
    const after = listStrip([track(T('hip-hop')), track(T('rock'))]);
    expect(before.placed).toBe(1);
    expect(after.placed).toBe(2);
    expect(after.gradient).not.toBe(before.gradient);
  });
});
