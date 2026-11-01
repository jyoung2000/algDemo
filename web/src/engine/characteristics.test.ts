import { describe, expect, it } from 'vitest';
import { characteristicsOf } from './local-api';

describe('characteristicsOf', () => {
  it('uses Apple Music\'s single genre when the song has no tag list', () => {
    const c = characteristicsOf({ extra: { genre: 'Hip-Hop/Rap' }, bpm: 150, release: { date: '2013-01-01' } }, null);
    expect(c['genres']).toEqual(['Hip-Hop/Rap']);
    expect(c['family']).toBe('Hip-hop');
    expect(c['release_year']).toBe('2013');
  });

  it('keeps the tag list when there is one', () => {
    const tags = [{ name: 'rock', label: 'Rock', confidence: 0.8 }];
    const c = characteristicsOf({ tags, extra: { genre: 'Pop' } }, null);
    expect(c['genres']).toEqual(['Rock']);
  });

  it('leaves a song with no genre information empty rather than inventing one', () => {
    const c = characteristicsOf({ extra: { genre: null } }, null);
    expect(c['genres']).toEqual([]);
    expect(c['family']).toBeNull();
  });
});
