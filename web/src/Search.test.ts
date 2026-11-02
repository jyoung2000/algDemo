import { describe, expect, it } from 'vitest';
import { liveLyricsReady } from './Search';

describe('liveLyricsReady: when typed words are enough to search lyrics live', () => {
  it('waits for a second word', () => {
    expect(liveLyricsReady('')).toBe(false);
    expect(liveLyricsReady('making')).toBe(false);
    expect(liveLyricsReady('  making  ')).toBe(false);
  });
  it('waits for a few letters even with two words', () => {
    expect(liveLyricsReady('a b')).toBe(false);
    expect(liveLyricsReady('so me')).toBe(false);
  });
  it('searches from two real words', () => {
    expect(liveLyricsReady('making this')).toBe(true);
    expect(liveLyricsReady('  time   left  ')).toBe(true);
    expect(liveLyricsReady("making this song just in case we ain't got no time left")).toBe(true);
  });
});

import { lyricsLead } from './Search';

describe('lyricsLead: which half of a plain-text answer goes first', () => {
  it('keeps titles first for a short query, even with lyric matches', () => {
    expect(lyricsLead('slayr', 3)).toBe(false);
    expect(lyricsLead('time left', 3)).toBe(false);
  });
  it('puts lyric matches first for a line of a song', () => {
    expect(lyricsLead("just in case we ain't got no time left", 2)).toBe(true);
  });
  it('never leads with an empty lyric list', () => {
    expect(lyricsLead("just in case we ain't got no time left", 0)).toBe(false);
  });
});
