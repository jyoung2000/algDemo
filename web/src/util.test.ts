import { describe, expect, it } from 'vitest';
import type { RecItem, TasteSummary } from './api';
import { classify } from './engine/classify';
import { SUBS } from './engine/genre-table';
import type { Tag } from './engine/genres';
import { ListenMeter, addSeed, historyBack, isSilent, nextRepeat, stepQueue, toggleMuteState, describeCharacteristics, describeTaste, genreBubbles, genreTags, mergeRerank, pickerColorFor, playbackOfTrack, qualifiesCompletion, toneLabel } from './util';

const item = (key: string, rank: number): RecItem => ({ rank, track: { key } }) as unknown as RecItem;

describe('describeCharacteristics', () => {
  it('lists tempo, genres, year and fit; says nothing for unknowns', () => {
    expect(describeCharacteristics({ bpm: 92, genres: ['Hip Hop', 'Rap', 'Soul'], explicit: true, duration: 200, release_year: '2024', popularity: null, taste_fit: 0.824 })).toEqual([
      '92 BPM', '2024', 'Explicit', '82% fit to your listening',
    ]);
    expect(describeCharacteristics({ bpm: null, genres: [], explicit: null, duration: null, release_year: null, popularity: null, taste_fit: null })).toEqual([]);
    expect(describeCharacteristics(undefined)).toEqual([]);
  });

  it('names the family and subgenre, or the family alone, and exposes it as the tone label', () => {
    const base = { bpm: null, genres: [], explicit: null, duration: null, release_year: null, popularity: null, taste_fit: null };
    expect(toneLabel({ ...base, family: 'Hip-hop', subgenre: 'Trap' })).toBe('Trap');
    expect(toneLabel({ ...base, family: 'Rock', subgenre: null })).toBe('Rock');
    // the family is not repeated when a genre label already says it
    expect(toneLabel({ ...base, genres: ['Rock'], family: 'Rock', subgenre: null })).toBeNull();
    expect(toneLabel({ ...base, genres: ['Pop / Rock'], family: 'Rock', subgenre: null })).toBeNull();
    expect(toneLabel({ ...base, family: 'Rock', subgenre: null })).toBe('Rock');
    expect(toneLabel({ ...base })).toBeNull();
  });
});

describe('describeTaste', () => {
  const t: TasteSummary = { events: 5, positives: 3, negatives: 2, bpm: 92, skip_bpm: 170, likes: [{ name: 'hip hop', label: 'Hip Hop', score: 0.6 }], avoids: [{ name: 'metal', label: 'Metal', score: -0.5 }] };
  it('says what was learned in words', () => {
    expect(describeTaste(t)).toBe('Learned from 5 songs you played: you keep Hip Hop; you skip Metal; you stay near 92 BPM.');
  });
  it('is empty with no listening', () => {
    expect(describeTaste(null)).toBe('');
    expect(describeTaste({ ...t, events: 0 })).toBe('');
  });
});

describe('ListenMeter: actual time and unique content coverage', () => {
  it('excludes seeks, pauses and buffering; a replay adds time but not coverage', () => {
    const m = new ListenMeter();
    m.tick(0, true);
    m.tick(0.5, true);
    m.tick(1, true);
    m.tick(1, false);
    m.tick(1, false); // paused interval
    m.seeked(20); // seeking forward does not count as heard
    m.tick(20.5, true);
    m.tick(21, true);
    m.seeked(0); // replay the first second
    m.tick(0.5, true);
    m.tick(1, true);
    expect(m.listened).toBeCloseTo(3);
    expect(m.coverage).toBeCloseTo(2);
    m.tick(50, true); // discontinuity/buffering: not an actual playing interval
    expect(m.listened).toBeCloseTo(3);
    expect(m.coverage).toBeCloseTo(2);
  });
  it('an end reached by seeking ahead is not a full-track completion', () => {
    expect(qualifiesCompletion('full', 20, 180)).toBe(false);
    expect(qualifiesCompletion('full', 130, 180)).toBe(true);
    expect(qualifiesCompletion('preview', 20, 30)).toBe(false);
    expect(qualifiesCompletion('preview', 25, 30)).toBe(true);
    expect(qualifiesCompletion('full', 20, null)).toBe(true); // duration unknown; no ratio claimed
  });
});

describe('mergeRerank', () => {
  it('keeps played songs first, drops duplicates, renumbers', () => {
    const prev = [item('a', 1), item('b', 2), item('c', 3)];
    const next = [item('d', 1), item('b', 2), item('c', 3)];
    const out = mergeRerank(prev, next, new Set(['a', 'b']));
    expect(out.map((x) => x.track.key)).toEqual(['a', 'b', 'd', 'c']);
    expect(out.map((x) => x.rank)).toEqual([1, 2, 3, 4]);
  });
});

describe('playbackOfTrack open links', () => {
  // one link per service: also_on can name the same service more than once, and the primary service may repeat in it
  const base = { provider: 'ytmusic', platform_id: 'abc', url: 'https://music.youtube.com/watch?v=abc', title: 'Around the World', artist: 'Daft Punk' };
  it('lists the primary service once, then each other service once', () => {
    const t = {
      ...base,
      also_on: [
        { provider: 'deezer', url: 'https://deezer.example/1' },
        { provider: 'apple', url: 'https://apple.example/1' },
        { provider: 'apple', url: 'https://apple.example/1' },
        { provider: 'apple', url: 'https://apple.example/2' },
        { provider: 'spotify', url: 'https://open.spotify.example/1' },
        { provider: 'spotify', url: 'https://open.spotify.example/1' },
        { provider: 'ytmusic', url: 'https://music.youtube.com/watch?v=abc' },
      ],
    } as never;
    expect(playbackOfTrack(t).open.map((o) => o.provider)).toEqual(['ytmusic', 'deezer', 'apple', 'spotify']);
  });
  it('skips an entry with no url', () => {
    const t = { ...base, also_on: [{ provider: 'deezer', url: '' }] } as never;
    expect(playbackOfTrack(t).open.map((o) => o.provider)).toEqual(['ytmusic']);
  });
});

describe('addSeed', () => {
  const t = (key: string) => ({ key, title: key, artists: [key] }) as never;
  it('puts the newest starting song at the top and rejects the same recording twice', () => {
    const one = addSeed([], t('a|x'));
    expect(one.added).toBe(true);
    const two = addSeed(one.seeds, t('b|y'));
    expect(two.seeds.map((s: { key: string }) => s.key)).toEqual(['b|y', 'a|x']);
    const dup = addSeed(two.seeds, t('a|x'));
    expect(dup.added).toBe(false);
    expect(dup.seeds).toBe(two.seeds);
  });
});

describe('genreTags', () => {
  const base = { bpm: null, genres: [] as string[], explicit: null, duration: null, release_year: null, popularity: null, taste_fit: null };
  it('lists the main genre first, then the subgenre, with no separators in any bubble', () => {
    const tags = genreTags({ ...base, genres: ['Rap / Hip Hop', 'Hip-hop / Alternative'], family: 'Hip-hop', subgenre: 'Rage' });
    expect(tags).toEqual(['Rap', 'Rage']);
    for (const t of tags) expect(t).not.toMatch(/[\/·,]/);
  });
  it('splits a slashed subgenre and keeps it, dropping the duplicate main-genre copy', () => {
    // Main genre first, then the subgenre, as above; the provider's "underground hip hop" IS that subgenre.
    const tags = genreTags({ ...base, genres: ['Rap', 'Hip Hop', 'underground hip hop'], family: 'Hip-hop', subgenre: 'Alternative / underground hip-hop' });
    expect(tags).toEqual(['Rap', 'Alternative hip-hop']);
    for (const t of tags) expect(t).not.toMatch(/[\/·,]/);
  });
  it('drops the duplicate rap / hip-hop names a song repeats', () => {
    expect(genreTags({ ...base, genres: ['Rap / Hip Hop', 'hip-hop', 'Hip Hop'] })).toEqual(['Rap']);
  });
  it('uses the family as the main genre when the provider names none', () => {
    expect(genreTags({ ...base, genres: [], family: 'Hip-hop', subgenre: 'Rage' })).toEqual(['Hip-hop', 'Rage']);
  });
  it('is empty when the song has no genre', () => {
    expect(genreTags({ ...base })).toEqual([]);
    expect(genreTags(undefined)).toEqual([]);
  });
});

describe('pickerColorFor', () => {
  it('gives a genre the Taste Picker colour, the same colour for the same genre', () => {
    expect(pickerColorFor('Rap')).toMatch(/^#[0-9a-f]{6}$/); // TAGS-COLOR-001: palette hex
    expect(pickerColorFor('Rap')).toBe(pickerColorFor('Rap'));
  });
});

// TAGS-CANON-001: one genre is one bubble, named one way, in the Taste Picker's colour for that genre.
describe('genre bubbles follow the Taste Picker', () => {
  const base = { bpm: null, genres: [] as string[], explicit: null, duration: null, release_year: null, popularity: null, taste_fit: null };
  const pickerColour = (word: string) => classify([{ name: word, label: word, confidence: 1 }] as Tag[], null)!.color;
  const rnb = pickerColour('r&b');
  const pop = pickerColour('pop');

  it('gives R&B its own picker colour however it is written, never the song\'s colour', () => {
    for (const w of ['R&B', 'r&b', 'rnb', 'RnB', 'r and b', 'Rhythm and Blues']) expect(pickerColorFor(w), w).toBe(rnb);
    expect(rnb).not.toBe(pop);
    // A pop song's R&B bubble is R&B-coloured, not pop-coloured.
    const popSong = genreBubbles({ ...base, genres: ['Pop', 'rnb'], family: 'Pop', color: pop });
    expect(popSong).toEqual([{ label: 'Pop', color: pop, sub: false }, { label: 'R&B', color: rnb, sub: false }]);
  });

  it('shows R&B once, spelt R&B, when providers spell it several ways', () => {
    expect(genreTags({ ...base, genres: ['rnb', 'R&B', 'r&b'] })).toEqual(['R&B']);
  });

  it('does not split a picker family into genres the song was never tagged with', () => {
    const tags = genreTags({
      ...base,
      genres: ['Pop', 'rnb'],
      family: 'Pop',
      families: [
        { family: 'Pop', subgenre: null, color: pop },
        { family: 'R&B/Afro/Latin', subgenre: null, color: rnb },
        { family: 'Soul/Jazz/Funk', subgenre: null, color: pickerColour('soul') },
      ],
    });
    expect(tags).not.toContain('Afro');
    expect(tags).not.toContain('Latin');
    expect(tags).not.toContain('Jazz');
    expect(tags).not.toContain('Funk');
    expect(tags).toEqual(['Pop', 'R&B', 'Soul']);
  });

  it('names every genre in one consistent case', () => {
    expect(genreTags({ ...base, genres: ['soul', 'hip hop', 'ELECTRONIC'] })).toEqual(['Soul', 'Hip-hop', 'Electronic']);
    expect(genreTags({ ...base, genres: ['electronic'] })).toEqual(['Electronic']);
  });

  it('shows a picker subgenre as one slash-free bubble, merged with the provider word for it', () => {
    const disco = genreBubbles({ ...base, genres: ['disco', 'Pop'], families: [{ family: 'Soul/Jazz/Funk', subgenre: 'Nu-disco / disco revival', color: '' }] });
    // Its family leads it, as Rap leads Rage: main genre first, then the subgenre.
    expect(disco.map((b) => b.label)).toEqual(['Pop', 'Soul', 'Nu-disco']);
    expect(disco[2]!.color).toBe(pickerColour('nu-disco'));
  });

  it('every picker subgenre has a slash-free name that leads back to its own colour', () => {
    for (const s of SUBS) {
      const b = genreBubbles({ ...base, families: [{ family: 'none', subgenre: s.name, color: '' }] }).find((x) => x.sub);
      expect(b, s.name).toBeDefined();
      expect(b!.label, s.name).not.toMatch(/[/·,()]/);
      expect(b!.color, s.name).toBe(pickerColour(s.key));
      expect(pickerColorFor(b!.label), b!.label).toBe(b!.color);
    }
  });

  it('gives a genre the picker has no place for no bubble, so no bubble is grey', () => {
    const b = genreBubbles({ ...base, genres: ['World', 'Soul'] });
    expect(b).toEqual([{ label: 'Soul', color: pickerColour('soul'), sub: false }]);
  });

  it('gives a genre placed through its parent its family colour, named as words (GENRE-CLASS-001)', () => {
    expect(genreBubbles({ ...base, genres: ['Gospel'] })).toEqual([{ label: 'Gospel', color: pickerColour('soul'), sub: false }]);
    expect(genreBubbles({ ...base, genres: ['deep house'] })).toEqual([{ label: 'Deep house', color: pickerColour('electronic'), sub: false }]);
    // SoundCloud's joined genre reads as the main genre; the subgenre keeps its own shade.
    expect(genreBubbles({ ...base, genres: ['R&B & Soul', 'alternative r&b'] }).map((x) => [x.label, x.sub])).toEqual([['R&B', false], ['Alt R&B', true]]);
  });
});

const song = (key: string): RecItem => ({ rank: 1, track: { key }, playback: { preview: 'p', embed: null } }) as unknown as RecItem;
const list = ['a', 'b', 'c', 'd'].map(song);
const none = new Set<string>();

describe('stepQueue (shuffle and repeat)', () => {
  it('walks the list in order and stops at its end when repeat is off', () => {
    const o = { shuffle: false, repeat: 'off' as const, heard: none };
    expect(stepQueue(list, 'a', 1, none, o)?.item.track.key).toBe('b');
    expect(stepQueue(list, 'd', 1, none, o)).toBeNull();
    expect(stepQueue(list, 'a', -1, none, o)).toBeNull();
  });

  it('wraps round both ends with repeat all', () => {
    const o = { shuffle: false, repeat: 'all' as const, heard: none };
    expect(stepQueue(list, 'd', 1, none, o)).toMatchObject({ wrapped: true, item: { track: { key: 'a' } } });
    expect(stepQueue(list, 'a', -1, none, o)).toMatchObject({ wrapped: true, item: { track: { key: 'd' } } });
  });

  it('shuffles through every song once before any repeats, then stops (repeat off)', () => {
    const heard = new Set(['a']);
    let cur = 'a';
    const seen = ['a'];
    for (let i = 0; i < 10; i++) {
      const s = stepQueue(list, cur, 1, none, { shuffle: true, repeat: 'off', heard });
      if (!s) break;
      cur = s.item.track.key;
      heard.add(cur);
      seen.push(cur);
    }
    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('starts a new shuffled round with repeat all, never repeating the song just played', () => {
    const heard = new Set(['a', 'b', 'c', 'd']);
    for (let r = 0; r < 30; r++) {
      const s = stepQueue(list, 'c', 1, none, { shuffle: true, repeat: 'all', heard, rand: () => r / 30 });
      expect(s?.wrapped).toBe(true);
      expect(s?.item.track.key).not.toBe('c');
    }
  });

  it('shuffled, commits to the announced next song: the same pick is returned until it is played (SHUFFLE-NEXT-001)', () => {
    // The player cues and downloads "up next" ahead of time and blends into it; a fresh random
    // pick at the handoff would land the blend on a song that then never plays.
    const heard = new Set(['a']);
    let r = 0;
    const o = { shuffle: true, repeat: 'off' as const, heard, rand: () => [0.1, 0.9, 0.5, 0.7][r++ % 4]! };
    const first = stepQueue(list, 'a', 1, none, o)?.item.track.key;
    expect(stepQueue(list, 'a', 1, none, o)?.item.track.key).toBe(first);
    expect(stepQueue(list, 'a', 1, none, o)?.item.track.key).toBe(first);
    // The pick holds only while the same song is current and the pick itself is still fresh.
    heard.add(first!);
    const second = stepQueue(list, first!, 1, none, o)?.item.track.key;
    expect(second).not.toBe(first);
    expect(stepQueue(list, first!, 1, none, o)?.item.track.key).toBe(second);
  });

  it('skips hidden and unplayable songs', () => {
    const l = [song('a'), { ...song('b'), playback: { preview: null, embed: null } } as RecItem, song('c'), song('d')];
    const o = { shuffle: false, repeat: 'off' as const, heard: none };
    expect(stepQueue(l, 'a', 1, new Set(['c']), o)?.item.track.key).toBe('d');
  });
});

describe('historyBack', () => {
  it('goes back to the song heard before, skipping the current one and hidden ones', () => {
    expect(historyBack(['a', 'c', 'b'], 'b', list, none)).toMatchObject({ item: { track: { key: 'c' } }, keep: 2 });
    expect(historyBack(['a', 'c', 'b'], 'b', list, new Set(['c']))).toMatchObject({ item: { track: { key: 'a' } }, keep: 1 });
    expect(historyBack(['a'], 'a', list, none)).toBeNull();
  });
});

describe('repeat modes and volume helpers', () => {
  it('cycles off, all, one, off', () => {
    expect([nextRepeat('off'), nextRepeat('all'), nextRepeat('one')]).toEqual(['all', 'one', 'off']);
  });

  it('treats slider 0 as silent, since YouTube ignores a volume of 0', () => {
    expect(isSilent({ value: 0, muted: false })).toBe(true);
    expect(isSilent({ value: 0.4, muted: true })).toBe(true);
    expect(isSilent({ value: 0.4, muted: false })).toBe(false);
  });

  it('mutes keeping the level, and unmutes back to it (or to the last level from slider 0)', () => {
    expect(toggleMuteState({ value: 0.6, muted: false }, 0.6)).toEqual({ value: 0.6, muted: true });
    expect(toggleMuteState({ value: 0.6, muted: true }, 0.6)).toEqual({ value: 0.6, muted: false });
    expect(toggleMuteState({ value: 0, muted: false }, 0.7)).toEqual({ value: 0.7, muted: false });
    expect(toggleMuteState({ value: 0, muted: false }, 0)).toEqual({ value: 0.5, muted: false });
  });
});
