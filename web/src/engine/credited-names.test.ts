import { describe, expect, it } from 'vitest';
import type { Track } from '../api';
import { creditedTrack } from './credited-names';
const t = (title: string, artists = ['Lead']) => ({id:'t',key:'t',platform_id:'123',provider:'deezer',title,artist:artists.join(', '),artists} as Track);
describe('explicit displayed guest credits, without changing recording identity', () => {
  it.each(['Song (feat. Guest)', 'Song [ft. Guest]', 'Song (featuring Guest)', 'Song feat. Guest', 'Song ft Guest'])('reads %s', title => {
    expect(creditedTrack(t(title)).artists).toEqual(['Lead','Guest']);
  });
  it('shows all explicit guests as separate names', () => {
    expect(creditedTrack(t('Song (feat. First, Second & Third and Fourth)')).artists).toEqual(['Lead','First','Second','Third','Fourth']);
  });
  it('does not repeat metadata credits or the lead', () => {
    expect(creditedTrack(t('Song (feat. guest, Lead)', ['Lead','Guest'])).artists).toEqual(['Lead','Guest']);
  });
  it('preserves a known band name and does not mutate the source track', () => {
    const source=t('Song (feat. Earth, Wind & Fire)', ['Lead','Earth, Wind & Fire']);
    expect(creditedTrack(source).artists).toEqual(source.artists);
    expect(source.artists).toEqual(['Lead','Earth, Wind & Fire']);
    expect(creditedTrack(source).title).toBe(source.title);
  });
  it.each(['With or Without You','Featuring Tomorrow','Song with Hope','Song (Remix)','Song (Live at Guest Hall)'])('does not invent a guest for %s', title => {
    expect(creditedTrack(t(title)).artists).toEqual(['Lead']);
  });
});
