import { describe, expect, it } from 'vitest';
import { classifyStation } from './radio-genres';

/** The first 24 stations of the owner's Radio tab (Radio Browser), 2026-11-19, as the directory lists them. */
const STATIONS: { name: string; tags: string[]; language: string; countryCode: string }[] = [{"name": "Christmas FM Non-stop!", "tags": ["advent", "canti natalizi", "canzoni di natale", "carols", "chansons de noël", "christmas", "christmas carols", "christmas choir", "christmas classics", "christmas hits"], "language": "italian", "countryCode": "FI"}, {"name": "Radio Armisa", "tags": ["anni 80", "anni 90", "balera", "dance", "folk", "italiana", "liscio", "oldies", "pop", "popolare"], "language": "english,italian", "countryCode": "IT"}, {"name": "RTL", "tags": ["généraliste"], "language": "", "countryCode": "FR"}, {"name": "France Info", "tags": ["aac", "information", "public radio", "radio france"], "language": "french", "countryCode": "FR"}, {"name": "Classic Vinyl HD", "tags": ["1930", "1940", "1950", "1960", "beautiful music", "big band", "classic hits", "crooners", "easy", "easy listening"], "language": "english", "countryCode": "US"}, {"name": "MANGORADIO", "tags": ["music", "variety"], "language": "english,german", "countryCode": "DE"}, {"name": "Europe 1", "tags": ["génaraliste"], "language": "french", "countryCode": "FR"}, {"name": "Anon.FM", "tags": ["anime", "dnb", "downtempo", "experimental", "jazz", "psychedelic", "rock", "trance"], "language": "english,russian,ukrainian", "countryCode": "RU"}, {"name": "RMC Info Talk Sport", "tags": ["sports news"], "language": "french", "countryCode": "FR"}, {"name": "101 SMOOTH JAZZ", "tags": ["easy listening", "jazz", "smooth jazz"], "language": "english", "countryCode": "US"}, {"name": "France Inter", "tags": ["debate", "music", "news"], "language": "french", "countryCode": "FR"}, {"name": "SWR3", "tags": ["news", "pop", "rock"], "language": "german", "countryCode": "DE"}, {"name": "Deutschlandfunk | DLF | MP3 128k", "tags": ["culture", "news", "public service", "information"], "language": "german", "countryCode": "DE"}, {"name": "Nostalgie HQ", "tags": [], "language": "", "countryCode": "FR"}, {"name": "Radio Paradise Main Mix (EU) 320k AAC", "tags": ["california", "eclectic", "free", "internet", "non-commercial", "paradise", "radio"], "language": "english", "countryCode": "US"}, {"name": "FUN Radio", "tags": ["dance", "electro", "latino"], "language": "french", "countryCode": "FR"}, {"name": "80s80s Radio", "tags": ["80s", "new wave", "pop", "rock"], "language": "", "countryCode": "DE"}, {"name": "Heart 80s", "tags": ["80s", "national", "pop", "public radio", "variety"], "language": "english", "countryCode": "GB"}, {"name": "Nrj Hits", "tags": ["hits"], "language": "french", "countryCode": "FR"}, {"name": "Dance Wave! | MP3", "tags": ["club dance electronic house trance"], "language": "english", "countryCode": ""}, {"name": "Bollywood Gaane Purane", "tags": [], "language": "", "countryCode": "IN"}, {"name": "Virgin Radio Türkiye", "tags": ["pop rock"], "language": "turkish", "countryCode": "TR"}, {"name": "Power POP", "tags": ["00s", "70s", "80s", "90s", "pop", "rock"], "language": "turkish", "countryCode": "TR"}, {"name": "Fox News Radio", "tags": ["news"], "language": "american english", "countryCode": "US"}];
const labels = (name: string) => classifyStation(STATIONS.find((s) => s.name === name)!).map((b) => (b.sub ? '~' : '') + b.label + (b.guess ? '?' : ''));

describe('RADIO-GENRES-001: every station gets a main genre or format and a subgenre', () => {
  it('tags every one of the owner\'s stations with a main genre and at least one subgenre, never "Genre not listed"', () => {
    for (const s of STATIONS) {
      const b = classifyStation(s);
      expect(b[0]!.sub, s.name).toBe(false);
      expect(b[0]!.label, s.name).not.toBe('Genre not listed');
      expect(b.some((x) => x.sub), `${s.name}: ${b.map((x) => x.label)}`).toBe(true);
    }
  });
  it('reads formats in any language, splits joined tags, and drops places and codecs', () => {
    expect(labels('RTL')).toEqual(['Variety', '~French variety']);
    expect(labels('France Info')).toEqual(['News', '~Public radio']);
    expect(labels('RMC Info Talk Sport')).toEqual(['Sports', '~Sports news']);
    expect(labels('Fox News Radio')).toEqual(['News', '~US news']);
    expect(labels('Christmas FM Non-stop!')).toEqual(['Christmas', '~Carols', '~Christmas hits']);
    expect(labels('Radio Paradise Main Mix (EU) 320k AAC')).toEqual(['Variety', '~Eclectic']);
    expect(labels('Nrj Hits')).toEqual(['Pop', '~Top 40']);
    expect(labels('Dance Wave! | MP3')[0]).toMatch(/Dance|Electronic|House/);
  });
  it('leads with the music a station mostly plays, not the first tag A to Z', () => {
    expect(labels('101 SMOOTH JAZZ').slice(0, 2)).toEqual(['Jazz', '~Smooth jazz']);
    expect(labels('SWR3')).toEqual(['Pop', '~Rock', '~News']);
    expect(labels('Anon.FM').slice(0, 2)).toEqual(['Variety', '~Drum & bass']);
    expect(labels('Radio Armisa')[0]).toBe('Pop');
    expect(labels('Deutschlandfunk | DLF | MP3 128k')[0]).toBe('News');
    expect(labels('Virgin Radio Türkiye')).toEqual(['Rock', '~Pop rock']);
  });
  it('calls a station spread over many kinds of music with none leading Variety, not its first tag (KEXP)', () => {
    const kexp = { name: 'KEXP', tags: ['afrobeats', 'alternative', 'alternative rock', 'ambient', 'dj mixes', 'dj remix', 'djs', 'electronic', 'folk', 'highlife'], language: 'english', countryCode: 'US' };
    const b = classifyStation(kexp).map((x) => (x.sub ? '~' : '') + x.label);
    expect(b[0]).toBe('Variety');
    expect(b.length).toBeGreaterThan(1);
  });
  it('reads a station with no listed genre from its name, as an estimate', () => {
    expect(labels('Nostalgie HQ')).toEqual(['Oldies?', '~French oldies']);
    expect(labels('Bollywood Gaane Purane').slice(0, 2)).toEqual(['Bollywood?', '~Oldies?']);
  });
  it('uses the song playing now when neither the directory nor the name says, and says so', () => {
    expect(classifyStation({ name: 'Radio Zebra 7', tags: [], nowPlaying: ['hip hop', 'trap'] }).map((b) => b.label)).toEqual(['Hip-hop', 'Trap']);
    expect(classifyStation({ name: 'Radio Zebra 7', tags: [] })[0]!.label).toBe('Genre not listed');
  });
});
