/**
 * RADIO-GENRES-001 (owner, 2026-11-19): "all music and programming should be tagged", with a main genre
 * and a subgenre, as accurate as possible.
 *
 * A radio directory's tags are free text in any language: real genres ("jazz"), formats ("généraliste",
 * "information", "anni 80"), places ("california"), and noise ("free", "128k"). This turns them into
 * what a station plays: one main genre or programming format, then subgenres. Every label says where it
 * came from; nothing is invented when nothing is known. Station-format tags describe the station only,
 * never the songs it plays (RADIO-TASTE-001). Pure, so every rule is tested without a network.
 */
import { genreIdentity } from './genre-identity';
import { fold } from './identity';

export interface StationGenre {
  label: string;
  color: string;
  /** A subgenre rather than the main genre or format. */
  sub: boolean;
  /** An estimate of ours (read from the station's name, or from the song playing now). */
  guess?: boolean;
  /** Where it came from, for the bubble's title. */
  why?: string;
}

export interface StationFacts {
  tags: readonly string[];
  name: string;
  language?: string;
  countryCode?: string;
  /** Main genres of the song the station is playing now, when one was identified. */
  nowPlaying?: readonly string[];
}

/** Programming formats: what a station broadcasts when it is not one genre of music. */
type Format = 'News' | 'Talk' | 'Sports' | 'Variety' | 'Christmas' | 'Religious' | 'Culture' | 'Comedy' | 'Kids' | 'Oldies';
const FORMAT_TONE: Record<Format, string> = {
  News: '#3867d6', Talk: '#0e8f8f', Sports: '#1f9d55', Variety: '#7a3be1', Christmas: '#d23b68', Religious: '#b8860b',
  Culture: '#8e3a6f', Comedy: '#e1712d', Kids: '#2d9ee1', Oldies: '#c2571a',
};

/** What one directory word means: a format, a sub-format, a genre, a decade, or nothing. */
type Meaning =
  | { kind: 'format'; format: Format; sub?: string }
  | { kind: 'sub'; label: string; format?: Format; genre?: string }
  | { kind: 'genre'; word: string; sub?: string }
  | { kind: 'decade'; label: string };

const W = (words: string): string[] => words.split('|').map((w) => fold(w));
const TABLE: [string[], Meaning][] = [
  [W('news|nachrichten|information|informations|info|infos|notizie|noticias|actualites|actualité|actualidad|nieuws|journalism|current affairs|haber|новости'), { kind: 'format', format: 'News' }],
  [W('news talk|news/talk|news & talk|newstalk'), { kind: 'format', format: 'News', sub: 'Talk' }],
  [W('local news|regional news|lokalnachrichten'), { kind: 'format', format: 'News', sub: 'Local news' }],
  [W('world news|international news|business news|financial news|economy|business|finance'), { kind: 'format', format: 'News', sub: 'Business and world news' }],
  [W('weather|traffic|traffic and weather'), { kind: 'format', format: 'News', sub: 'Traffic and weather' }],
  [W('talk|debate|débat|debat|discussion|talk radio|parlato|hablada|gesprach|spoken word|interview|interviews|call in|phone in'), { kind: 'format', format: 'Talk' }],
  [W('sport|sports|football|soccer|fussball|calcio|futbol|deportes|baseball|basketball|nfl|nba|cricket'), { kind: 'format', format: 'Sports' }],
  [W('sports news|sport news|sports talk'), { kind: 'format', format: 'Sports', sub: 'Sports news' }],
  [W('generaliste|generalist|generalista|genaraliste|general|full service|variety|variete|varietes|varieta|mainstream|mixed|mix|various genres|everything|all genres|multi genre|multigenre'), { kind: 'format', format: 'Variety' }],
  [W('eclectic|freeform|free form'), { kind: 'format', format: 'Variety', sub: 'Eclectic' }],
  [W('christmas|xmas|advent|natale|canti natalizi|canzoni di natale|noel|weihnachten|weihnachtslieder|navidad|villancicos|holiday|holidays|christmas music'), { kind: 'format', format: 'Christmas' }],
  [W('carols|christmas carols|christmas choir|chansons de noel|chants de noel|christmas songs'), { kind: 'format', format: 'Christmas', sub: 'Carols' }],
  [W('christmas classics|christmas hits|christmas pop'), { kind: 'format', format: 'Christmas', sub: 'Christmas hits' }],
  [W('religious|religion|christian|catholic|catolica|catholique|evangelical|worship|church|islam|islamic|quran|coran|bible|spiritual|devotional|bhajan'), { kind: 'format', format: 'Religious' }],
  [W('culture|kultur|cultura|culturel|arts|art|literature|education|educational|documentary'), { kind: 'format', format: 'Culture' }],
  [W('comedy|humor|humour|comedie|stand up'), { kind: 'format', format: 'Comedy' }],
  [W('kids|children|childrens|enfants|kinder|bambini|ninos|family'), { kind: 'format', format: 'Kids' }],
  [W('oldies|golden oldies|nostalgie|nostalgia|retro|evergreen|evergreens|classic hits|gold|goldies|schlager oldies'), { kind: 'format', format: 'Oldies' }],
  [W('public radio|public service|public|service public|publique|public broadcaster|npr|bbc|radio france|ard|rai|cbc|abc'), { kind: 'sub', label: 'Public radio' }],
  [W('hits|top 40|top40|top 100|chart|charts|hit radio|top hits|hit music|hitradio|chr|contemporary hit radio'), { kind: 'genre', word: 'pop', sub: 'Top 40' }],
  [W('adult contemporary|ac|hot ac|soft ac|soft rock'), { kind: 'genre', word: 'pop', sub: 'Adult contemporary' }],
  [W('beautiful music|easy listening|lounge|chill|chillout|chill out|relax|relaxing'), { kind: 'genre', word: 'easy listening' }],
  [W('balera|liscio|ballroom|tanzmusik'), { kind: 'sub', label: 'Ballroom', genre: 'pop' }],
  [W('crooners|crooner'), { kind: 'sub', label: 'Crooners', genre: 'jazz' }],
  [W('anime|anisong|j pop|jpop|j-pop'), { kind: 'genre', word: 'j-pop', sub: 'Anime' }],
  [W('bollywood|filmi|hindi film'), { kind: 'genre', word: 'bollywood' }],
  [W('big band|swing'), { kind: 'genre', word: 'jazz', sub: 'Big band' }],
  [W('smooth jazz'), { kind: 'genre', word: 'jazz', sub: 'Smooth jazz' }],
  [W('club|club dance|dance hits|discotheque'), { kind: 'genre', word: 'dance', sub: 'Club' }],
  [W('latino|latina|latin hits|musica latina'), { kind: 'genre', word: 'latin' }],
  [W('schlager|volksmusik|chanson|chansons|canzone|musica italiana|turkce pop|turk pop|arabesk|k pop|kpop|c pop|cpop|mpb|sertanejo|forro|cumbia|banda|ranchera|bhangra|qawwali|afrobeats|afrobeat|highlife|soukous|rai|dangdut|enka|fado|flamenco|tango|bossa nova'), { kind: 'genre', word: '' }],
];
/** Words that are places, codecs, quality or praise, never what a station plays. */
const NOISE = new Set(W('fm|am|dab|dab+|hd|hq|128k|320k|mp3|aac|aac+|ogg|opus|flac|hls|stream|streaming|webradio|web radio|internet radio|online|radio|station|stations|music|musica|musique|musik|free|national|local|regional|community|non profit|nonprofit|independent|indie radio|commercial|24/7|24 7|live|best|the best|top|new|official|california|usa|us|uk|france|germany|italy|deutschland|europe|world|international|city|english|french|german|italian|spanish|turkish|russian|hindi|misc|various|unknown|unspecified|other|others|default|test'));

const DECADE = /^(?:(?:the\s+)?(\d{4}|\d{2})\s*(?:s|er|'s|’s)?|anni\s*(\d{2})|annees\s*(\d{2})|años\s*(\d{2})|(eighties|seventies|sixties|nineties|fifties))$/;
const WORD_DECADE: Record<string, string> = { fifties: '50s', sixties: '60s', seventies: '70s', eighties: '80s', nineties: '90s' };
function decadeOf(raw: string): string | null {
  const m = DECADE.exec(fold(raw));
  if (!m) return null;
  if (m[5]) return WORD_DECADE[m[5]]!;
  const n = m[1] ?? m[2] ?? m[3] ?? m[4];
  if (!n) return null;
  if (n.length === 4) { const y = Number(n); return y >= 1920 && y <= 2030 && y % 10 === 0 ? `${String(y).slice(2)}s` : null; }
  const d = Number(n);
  return d % 10 === 0 ? `${n}s` : null;
}

const LOOKUP = new Map<string, Meaning>();
for (const [words, meaning] of TABLE) for (const w of words) if (!LOOKUP.has(w)) LOOKUP.set(w, meaning);

function meaningOf(raw: string): Meaning | null {
  const f = fold(raw);
  if (!f || NOISE.has(f)) return null;
  const hit = LOOKUP.get(f);
  if (hit) return hit.kind === 'genre' && !hit.word ? { kind: 'genre', word: raw } : hit;
  const dec = decadeOf(raw);
  if (dec) return { kind: 'decade', label: dec };
  const id = genreIdentity(raw);
  if (id) return id.sub ? { kind: 'sub', label: id.label, genre: id.family } : { kind: 'genre', word: raw };
  return null;
}

/** A directory tag that is several genres in one ("club dance electronic house trance"). */
function splitCompound(raw: string): string[] {
  if (LOOKUP.has(fold(raw)) || meaningOf(raw)) return [raw];
  const toks = fold(raw).split(' ').filter(Boolean);
  if (toks.length < 3) return [raw];
  const parts = toks.filter((t) => meaningOf(t));
  return parts.length >= Math.ceil(toks.length * 0.6) ? parts : [raw];
}

const TOPIC_TONES = ['#e1712d', '#2d9ee1', '#8e3a6f', '#442de1', '#1f9d55', '#d23b68', '#b8860b', '#0e8f8f', '#7a3be1', '#c2571a', '#3867d6', '#20bf6b'];
function topicTone(label: string): string { let h = 0; for (const ch of label.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return TOPIC_TONES[h % TOPIC_TONES.length]!; }
const toneOf = (label: string): string => genreIdentity(label)?.color ?? topicTone(label);
const cap = (s: string): string => s.replace(/\s+/g, ' ').trim().replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()).replace(/\bR&b\b/g, 'R&B').replace(/\bAnd\b/g, 'and');
const sentence = (s: string): string => { const t = s.replace(/\s+/g, ' ').trim().toLowerCase(); return (t.charAt(0).toUpperCase() + t.slice(1)).replace(/\br&b\b/g, 'R&B'); };
const genreLabel = (word: string): string => {
  const id = genreIdentity(word);
  return id && !id.sub ? id.label : sentence(word);
};
/** "80s" or "70s–00s": the decades a station lists, oldest to newest (00s after 90s). */
const decadeSpan = (ds: readonly string[]): string => {
  const year = (d: string) => { const n = Number.parseInt(d, 10); return n < 30 ? 2000 + n : 1900 + n; };
  const sorted = [...new Set(ds)].sort((a, b) => year(a) - year(b));
  return sorted.length === 1 ? sorted[0]! : `${sorted[0]}–${sorted[sorted.length - 1]}`;
};

const LANGUAGE: Record<string, string> = {
  english: 'English', french: 'French', german: 'German', italian: 'Italian', spanish: 'Spanish', portuguese: 'Portuguese', dutch: 'Dutch',
  turkish: 'Turkish', russian: 'Russian', polish: 'Polish', greek: 'Greek', arabic: 'Arabic', hindi: 'Hindi', japanese: 'Japanese',
  korean: 'Korean', chinese: 'Chinese', mandarin: 'Mandarin', swedish: 'Swedish', norwegian: 'Norwegian', danish: 'Danish', finnish: 'Finnish',
  czech: 'Czech', hungarian: 'Hungarian', romanian: 'Romanian', ukrainian: 'Ukrainian', persian: 'Persian', farsi: 'Persian', hebrew: 'Hebrew',
  indonesian: 'Indonesian', tamil: 'Tamil', punjabi: 'Punjabi', urdu: 'Urdu', bengali: 'Bengali', serbian: 'Serbian', croatian: 'Croatian',
};
const COUNTRY: Record<string, string> = { US: 'US', GB: 'UK', CA: 'Canadian', AU: 'Australian', FR: 'French', DE: 'German', IT: 'Italian', ES: 'Spanish', TR: 'Turkish', IN: 'Indian', JP: 'Japanese', BR: 'Brazilian', MX: 'Mexican', NL: 'Dutch', RU: 'Russian', FI: 'Finnish', SE: 'Swedish', IE: 'Irish', NZ: 'New Zealand', CH: 'Swiss', AT: 'Austrian', BE: 'Belgian', PL: 'Polish', GR: 'Greek', PT: 'Portuguese' };

/** "French variety", "US news": the station's own language or country with its format, when nothing finer is listed. */
function regional(main: string, f: StationFacts): { label: string; why: string } | null {
  const langs = fold(f.language ?? '').split(/[\s,]+/).map((w) => LANGUAGE[w]).filter(Boolean);
  const country = COUNTRY[(f.countryCode ?? '').toUpperCase()];
  // English is spoken everywhere, so the country says more; any other language says more than the country.
  const lang = langs.find((l) => l !== 'English') ?? (country ? undefined : langs[0]);
  const where = lang ?? country;
  if (!where) return null;
  const low = /^(R&B|J-Pop|K-Pop)/.test(main) ? main : main.toLowerCase();
  return { label: `${where} ${low}`, why: lang ? `The directory lists this station as ${lang}-language.` : `The directory lists this station in ${(f.countryCode ?? '').toUpperCase()}.` };
}

/** Station names that say what the station plays, for a station whose directory entry says nothing. */
const NAME_HINTS: [RegExp, string][] = [
  [/\bbollywood\b/i, 'bollywood'], [/\bjazz/i, 'jazz'], [/\bclassic(al|que)\b|\bklassik/i, 'classical'], [/\brock\b/i, 'rock'], [/\bmetal\b/i, 'metal'],
  [/\bhip[ -]?hop\b|\brap\b/i, 'hip hop'], [/\br&b\b|\brnb\b/i, 'r&b'], [/\bsoul\b/i, 'soul'], [/\bblues\b/i, 'blues'], [/\bcountry\b/i, 'country'],
  [/\breggae\b/i, 'reggae'], [/\blatin[oa]?\b|\bsalsa\b/i, 'latin'], [/\bhouse\b/i, 'house'], [/\btechno\b/i, 'techno'], [/\btrance\b/i, 'trance'],
  [/\bdance\b|\bedm\b/i, 'dance'], [/\belectro(nic)?\b/i, 'electronic'], [/\bambient\b|\bchill/i, 'ambient'], [/\bfolk\b/i, 'folk'], [/\bpop\b|\bhits?\b/i, 'pop'],
  [/\bk-?pop\b/i, 'k-pop'], [/\banime\b|\bj-?pop\b/i, 'j-pop'], [/\bgospel\b|\bchristian\b|\bworship\b/i, 'Religious'], [/\bchristmas\b|\bxmas\b|\bweihnacht|\bno[eë]l\b/i, 'Christmas'],
  [/\bnostalgi|\boldies\b|\bretro\b|\bpurane\b|\bgold(en)?\b|\bclassic hits\b/i, 'Oldies'], [/\bnews\b|\binfo\b|\bnachrichten\b/i, 'News'], [/\btalk\b/i, 'Talk'],
  [/\bsport/i, 'Sports'], [/\bsoundtrack\b|\bmovie|\bfilm/i, 'soundtrack'], [/\b(\d0)s?\b.*\b\1s?\b|\b(\d0)s\b/i, ''],
];

const isFormat = (w: string): w is Format => Object.prototype.hasOwnProperty.call(FORMAT_TONE, w);

/**
 * What a station plays, as bubbles: the main genre or programming format first, then up to two
 * subgenres. The directory's own words first; a station of music genres leads with its music and
 * keeps news or talk as a subgenre; a station of only programming leads with that.
 */
export function classifyStation(f: StationFacts): StationGenre[] {
  const formats: { format: Format; sub?: string }[] = [];
  const genres: { word: string; sub?: string }[] = [];
  const subs: { label: string; genre?: string; format?: Format }[] = [];
  const decades: string[] = [];
  for (const raw of f.tags.flatMap(splitCompound)) {
    const m = meaningOf(raw);
    if (!m) continue;
    if (m.kind === 'format') formats.push(m.sub ? { format: m.format, sub: m.sub } : { format: m.format });
    else if (m.kind === 'genre') genres.push(m.sub ? { word: m.word, sub: m.sub } : { word: m.word });
    else if (m.kind === 'sub') subs.push(m);
    else decades.push(m.label);
  }
  const from = 'Listed by the station directory.';
  const out: StationGenre[] = [];
  const seen = new Set<string>();
  const push = (label: string, sub: boolean, why: string, color?: string, guess?: boolean) => {
    const k = fold(label);
    if (!label || seen.has(k) || out.length >= 3) return;
    seen.add(k);
    out.push({ label, color: color ?? toneOf(label), sub, why, ...(guess ? { guess: true } : {}) });
  };
  // Directory tags come sorted A to Z, so the first is not the main one. The main genre is the family
  // most of the station's genre words fall in (its name counts double); a station of music leads with
  // its music and keeps news or talk as a subgenre; one of programming only leads with its most-named
  // format (News before Talk before the rest on a tie).
  const famOf = (word: string): string => genreIdentity(word)?.family ?? fold(word);
  const named = NAME_HINTS.filter(([re, w]) => w && !isFormat(w) && re.test(f.name ?? '')).map(([, w]) => famOf(w));
  const votes = new Map<string, number>();
  for (const g of genres) votes.set(famOf(g.word), (votes.get(famOf(g.word)) ?? 0) + 1);
  for (const x of subs) if (x.genre) votes.set(famOf(x.genre), (votes.get(famOf(x.genre)) ?? 0) + 1);
  for (const n of named) if (votes.has(n)) votes.set(n, votes.get(n)! + 2);
  const formatOrder: Format[] = ['News', 'Talk', 'Sports', 'Religious', 'Culture', 'Christmas', 'Oldies', 'Comedy', 'Kids', 'Variety'];
  const fvotes = new Map<Format, number>();
  for (const x of formats) fvotes.set(x.format, (fvotes.get(x.format) ?? 0) + 1);
  const spoken = [...fvotes.entries()].filter(([k]) => ['News', 'Talk', 'Sports', 'Religious', 'Culture'].includes(k)).reduce((a, [, v]) => a + v, 0);
  const musicFirst = genres.length > 0 && !(spoken >= 2 && spoken > genres.length);
  const best0 = genres.length ? Math.max(...genres.map((g) => votes.get(famOf(g.word)) ?? 0)) : 0;
  const total = [...votes.values()].reduce((a, b) => a + b, 0);
  // A station spread over many families with no clear lead (KEXP: afrobeats, alternative rock, ambient,
  // electronic, folk, highlife) plays a bit of everything: Variety, then the genres it lists most.
  const spread = musicFirst && votes.size >= 4 && best0 <= 2 && best0 / Math.max(1, total) < 0.4 && !named.length;
  if (spread) {
    push('Variety', false, `${from} It lists ${votes.size} different kinds of music with none leading.`, FORMAT_TONE.Variety);
    const ranked = [...genres].sort((a, b) => (votes.get(famOf(b.word)) ?? 0) - (votes.get(famOf(a.word)) ?? 0));
    const fams = new Set<string>();
    for (const g of ranked) { const fm = famOf(g.word); if (fams.has(fm)) continue; fams.add(fm); push(genreLabel(g.word), true, from); }
  } else if (musicFirst) {
    const best = best0;
    const lead = genres.find((g) => named.includes(famOf(g.word)) && (votes.get(famOf(g.word)) ?? 0) === best) ?? genres.find((g) => (votes.get(famOf(g.word)) ?? 0) === best)!;
    const fam = famOf(lead.word);
    // Several styles of one family ("dnb, downtempo, trance") make the family the main genre; its styles are subgenres.
    const famId = genreIdentity(fam);
    const famWords = new Set(genres.filter((g) => famOf(g.word) === fam).map((g) => fold(genreLabel(g.word))));
    const leadLabel = famWords.size >= 2 && famId && !famId.sub && !famWords.has(fold(famId.label)) ? famId.label : genreLabel(lead.word);
    push(leadLabel, false, from);
    if (fold(leadLabel) !== fold(genreLabel(lead.word))) push(genreLabel(lead.word), true, from);
    // A finer listed word the genre table folds into its family ("pop rock" -> Rock) stays as the subgenre.
    if (/\s/.test(lead.word.trim()) && fold(lead.word) !== fold(leadLabel)) push(sentence(lead.word), true, from);
    if (decades.length) push(`${decadeSpan(decades)} ${leadLabel.toLowerCase()}`.replace(/ (r&b|j-pop|k-pop)$/i, (m) => m.toUpperCase()), true, from);
    if (lead.sub) push(lead.sub, true, from);
    for (const x of subs.filter((x) => !x.genre || famOf(x.genre) === fam)) push(x.label, true, from);
    for (const g of genres.filter((g) => g !== lead && famOf(g.word) === fam)) { push(genreLabel(g.word), true, from); if (g.sub) push(g.sub, true, from); }
    for (const g of genres.filter((g) => g !== lead && famOf(g.word) !== fam)) { push(genreLabel(g.word), true, from); if (g.sub) push(g.sub, true, from); }
    for (const x of subs.filter((x) => x.genre && famOf(x.genre) !== fam)) push(x.label, true, from);
    for (const x of formats) push(x.sub ?? x.format, true, from, FORMAT_TONE[x.format]);
  } else if (formats.length) {
    const top = Math.max(...fvotes.values());
    const leadFormat = formatOrder.find((k) => fvotes.get(k) === top)!;
    const lead = formats.find((x) => x.format === leadFormat && x.sub) ?? formats.find((x) => x.format === leadFormat)!;
    push(lead.format, false, from, FORMAT_TONE[lead.format]);
    for (const x of formats.filter((x) => x.format === leadFormat && x.sub)) push(x.sub!, true, from);
    for (const x of subs) push(x.label, true, from);
    for (const x of formats.filter((x) => x.format !== leadFormat)) { push(x.format, true, from, FORMAT_TONE[x.format]); if (x.sub) push(x.sub, true, from); }
    if (decades.length) push(`${decadeSpan(decades)} hits`, true, from);
  } else if (decades.length || subs.length) {
    // Only decades or styles ("anni 80, anni 90, balera"): music from those years.
    const genre = subs.find((s) => s.genre)?.genre;
    const main = genre ? genreLabel(genre) : decades.length && decades.every((d) => Number.parseInt(d, 10) >= 50 && Number.parseInt(d, 10) <= 99) ? 'Oldies' : 'Pop';
    push(main, false, decades.length ? `The directory lists the station by decade (${decades.join(', ')}).` : from, isFormat(main) ? FORMAT_TONE[main] : undefined);
    if (decades.length) push(main === 'Oldies' ? `${decadeSpan(decades)} hits` : `${decadeSpan(decades)} ${main.toLowerCase()}`, true, from);
    for (const s of subs) push(s.label, true, from);
  }
  if (!out.length) {
    // Nothing listed: what the station's name says, then the song it is playing now; each an estimate.
    const name = f.name ?? '';
    const named = NAME_HINTS.filter(([re, w]) => w && re.test(name)).map(([, w]) => w);
    const decade = /\b(\d0)s?\b/.exec(name.replace(/(\d0)s?\1s?/g, '$1s'));
    for (const w of named) {
      const label = isFormat(w) ? w : genreLabel(w);
      push(label, out.length > 0, `Read from the station's name; the directory lists no genre for “${name}”.`, isFormat(w) ? FORMAT_TONE[w] : undefined, true);
    }
    if (out.length && decade) push(`${decade[1]}s hits`, true, `Read from the station's name.`, undefined, true);
    if (!out.length && f.nowPlaying?.length) {
      push(genreLabel(f.nowPlaying[0]!), false, 'From the song the station is playing now; the directory lists no genre.', undefined, true);
      for (const g of f.nowPlaying.slice(1)) push(genreLabel(g), true, 'From the song the station is playing now.', undefined, true);
    }
  }
  if (!out.length) return [{ label: 'Genre not listed', color: '#8a8f98', sub: false, why: `The directory lists no genre for “${f.name}”, and its name does not say.` }];
  // A main with nothing finer: its language or country, as the directory lists it ("French variety").
  if (!out.some((b) => b.sub)) {
    const r = regional(out[0]!.label, f);
    if (r) push(r.label, true, r.why, out[0]!.color);
  }
  return out;
}
