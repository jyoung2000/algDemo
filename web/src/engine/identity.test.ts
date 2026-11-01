import { describe, expect, it } from 'vitest';
import { matchRecordings, parseTitle, recordingKey, splitArtists } from './identity';

// Mirrors server/tests/test_identity.py, case for case.
const t = (title: string, artists: string[], duration: number | null = null, isrc: string | null = null, version = '') => ({
  title,
  artists,
  duration,
  isrc,
  version,
});

describe('identity (port of test_identity.py)', () => {
  it('keeps versions distinct', () => {
    const base = recordingKey('Blinding Lights', ['The Weeknd']);
    for (const v of ['Blinding Lights (Live)', 'Blinding Lights - Acoustic', 'Blinding Lights (Remix)', 'Blinding Lights (Sped Up)']) {
      expect(recordingKey(v, ['The Weeknd'])).not.toBe(base);
    }
  });

  it('folds editions and features together', () => {
    const a = recordingKey('Levitating (feat. DaBaby)', ['Dua Lipa']);
    const b = recordingKey('Levitating', ['Dua Lipa', 'DaBaby']);
    expect(a).toBe(b);
    expect(parseTitle('Levitating (feat. DaBaby)').featured).toEqual(['dababy']);
  });

  it('splits collaborations', () => {
    expect(splitArtists('Kendrick Lamar & SZA')).toEqual(['kendrick lamar', 'sza']);
    expect(splitArtists(['Calvin Harris, Dua Lipa'])).toEqual(['calvin harris', 'dua lipa']);
  });

  it('matches by ISRC', () => {
    expect(matchRecordings(t('X', ['A'], null, 'USUM71900001'), t('Totally different', ['B'], null, 'usum71900001')).verdict).toBe('same');
  });

  it('matches same title, artist and duration', () => {
    expect(matchRecordings(t('Weird Fishes/Arpeggi', ['Radiohead'], 318), t('Weird Fishes/Arpeggi', ['Radiohead'], 319)).verdict).toBe('same');
  });

  it('keeps a duration gap uncertain, never merged', () => {
    expect(matchRecordings(t('Song', ['A'], 200), t('Song', ['A'], 206)).verdict).toBe('uncertain');
  });

  it('treats same title by a different artist as different', () => {
    expect(matchRecordings(t('Hurt', ['Nine Inch Nails'], 373), t('Hurt', ['Johnny Cash'], 218)).verdict).toBe('different');
  });

  it('does not merge live or acoustic versions', () => {
    expect(matchRecordings(t('Song', ['A'], 200), t('Song (Live)', ['A'], 200)).verdict).toBe('different');
    expect(matchRecordings(t('Song', ['A'], 200), t('Song (Acoustic Version)', ['A'], 200)).verdict).toBe('different');
  });

  it('is uncertain with no duration', () => {
    expect(matchRecordings(t('Song', ['A']), t('Song', ['A'])).verdict).toBe('uncertain');
  });
});
