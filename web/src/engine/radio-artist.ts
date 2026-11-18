/**
 * RADIO-ARTIST-001: the artist a radio row opens. Broadcasters write the artist however their
 * playout system stores it: "JACKSON 5, THE", "The Jackson 5 - ABC", "Drake feat. Rihanna",
 * all capitals, or with the station's own name tacked on. Handing that raw text to the artist
 * page asked the services for a name nobody has, and the page came up empty. This module turns
 * the raw text into the primary artist's name, and prefers the catalogue's own artist (with its
 * provider id) when a confident match for the same song exists.
 *
 * Pure text work: station tags are never an input, and nothing here reaches the network.
 */
import { fold, parseTitle } from './identity';

/** The artist page's target, as `ArtistTarget` in api.ts: `dz:<id>` / `yt:<UC id>` plus the name. */
export interface RadioArtistTarget { id?: string; name: string }
/** The parts of a catalogue track this module reads. */
export interface RadioMatchTrack { title: string; artist?: string | null; artists?: string[] | null; artist_ids?: Record<string, string> | null }

const DZ_ID = /^\d{1,15}$/;
const YT_ARTIST = /^UC[A-Za-z0-9_-]{22}$/;
const NOT_AN_ARTIST = /^(unknown( artist)?|various( artists)?|va|n\/a|none|null|undefined)$/i;
/** A leading cue some playout systems put before the item. */
const LEAD_CUE = /^(?:now playing|now on air|on air|playing now|np|current(?:ly playing)?)\s*[:\-–—]\s*/i;
/** A spaced dash: the title or the station leaked into the artist field. */
const SPACED_DASH = /\s+[-–—]\s+/;
/** Station junk after a separator: "Artist | KISS FM", "Artist // radio", "Artist @ 98.7". */
const TRAILING_JUNK = /\s+(?:\||\/\/|•|·|@|::)\s*.*$/;
/** A trailing bracketed note: "[KISS FM]", "(Live)", "{HD}", "<Clean>". */
const TRAILING_BRACKET = /\s*[[({<][^\])}>]*[\])}>]\s*$/;
/** Featured / guest credits: everything from the marker on is a guest, not the lead. */
const FEATURED = /(?<=\S)\s*[([]?\s*\b(?:feat\.?|ft\.?|featuring|with|vs\.?|versus)\s+.*$/i;
/**
 * Joined credits. Kept together: "& the" / "and his" (Bob Marley & The Wailers), a family or group
 * word after "&" (Mumford & Sons), and ", The …" (Tyler, The Creator).
 */
const JOINED = /\s*(?:;|\s\/\s|,\s(?!the\b)|\s(?:&|and|\+)\s(?!(?:the|his|her|their)\b|(?:sons|daughters|brothers|sisters|friends|family|co\.?|company|crew|gang|band|orchestra)$))\s*/i;
const EDGE_LEAD = /^[\s"“”‘’`*.,;:\-–—_~]+/;
const EDGE_TRAIL = /[\s"“”‘’`*,;:\-–—_~]+$/;
/** Words kept in capitals when an all-caps name is title-cased. */
const KEEP_CAPS = /^(?:DJ|MC|UK|US|USA|NYC|LA|BTS|TLC|UB\d+|II|III|IV|VI|VII|VIII|IX|XX|R&B|[A-Z](?:\.[A-Z])+\.?)$/;
const SMALL = new Set(['of', 'and', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'de', 'la', 'le', 'y', 'n']);

function stripEdges(v: string): string { return v.replace(EDGE_LEAD, '').replace(EDGE_TRAIL, '').trim(); }

/** "JACKSON 5, THE" / "Beatles, The" → "The Jackson 5" / "The Beatles". */
function articleFirst(v: string): string {
  const m = /^(.+?),\s*(the|a|an|los|las|les|el|la|le|die|der|das)$/i.exec(v);
  return m ? `${m[2]} ${m[1]}` : v;
}

/** Sentence case for a name written in capitals; a name that already has lower case is left as written. */
export function titleCaseRadioName(v: string): string {
  if (!/\p{Lu}/u.test(v) || /\p{Ll}/u.test(v)) return v;
  const letters = v.replace(/[^\p{L}]/gu, '');
  // A short single acronym (ABBA, MGMT, AC/DC) is how the act writes itself.
  if (!/\s/.test(v.trim()) && letters.length <= 4) return v;
  return v.split(/(\s+)/).map((word, i) => {
    if (/^\s+$/.test(word) || KEEP_CAPS.test(word)) return word;
    const lower = word.toLowerCase();
    if (i > 0 && SMALL.has(lower)) return lower;
    // Capitalise the first letter and any letter after a hyphen or a leading O'/D' (O'Jays).
    return lower.replace(/(?<=^|[-/(]|^[od]')\p{L}/gu, (ch) => ch.toUpperCase());
  }).join('');
}

/** The raw artist text cleaned of cues, leaked titles and station junk ("X, The" is turned round per credit). */
function cleanArtistText(raw: string): string {
  let v = String(raw ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  v = v.replace(LEAD_CUE, '');
  const dash = SPACED_DASH.exec(v); if (dash) v = v.slice(0, dash.index);
  v = v.replace(TRAILING_JUNK, '');
  for (let i = 0; i < 3 && TRAILING_BRACKET.test(v) && !/^[[({<]/.test(v); i++) v = v.replace(TRAILING_BRACKET, '');
  return stripEdges(v);
}

function readable(v: string): string | null {
  const name = titleCaseRadioName(stripEdges(articleFirst(stripEdges(v))));
  return name && /[\p{L}\p{N}]/u.test(name) && !NOT_AN_ARTIST.test(name) ? name : null;
}

/** Every name the raw text credits, lead first: guests after "feat." and joined names after "&", ",". */
export function radioArtistCredits(raw: string): string[] {
  const full = cleanArtistText(raw);
  if (!full) return [];
  const featured = FEATURED.exec(full);
  const lead = featured ? full.slice(0, featured.index) : full;
  const guests = featured ? featured[0].replace(/^\s*[([]?\s*\b(?:feat\.?|ft\.?|featuring|with|vs\.?|versus)\s+/i, '').replace(/[)\]]\s*$/, '') : '';
  const out: string[] = [];
  for (const part of [...lead.split(JOINED), ...guests.split(JOINED)]) {
    const name = readable(part);
    if (name && !out.some((x) => fold(x) === fold(name))) out.push(name);
  }
  return out;
}

/** The primary artist the raw station text names, ready for the artist page; null when it names none. */
export function normaliseRadioArtist(raw: string | null | undefined): string | null {
  return raw ? radioArtistCredits(raw)[0] ?? null : null;
}

/** Comparison key: folded, with a leading "The" dropped (Deezer lists "Jackson 5", stations "The Jackson 5"). */
export const radioArtistKey = (name: string): string => fold(name).replace(/^the /, '');

/** The keys the raw text may stand for: the whole cleaned name (Earth, Wind & Fire) and each credit. */
export function radioArtistKeys(raw: string | null | undefined): Set<string> {
  const keys = new Set<string>();
  if (!raw) return keys;
  const whole = readable(cleanArtistText(raw).replace(FEATURED, ''));
  for (const name of [whole, ...radioArtistCredits(raw)]) if (name) keys.add(radioArtistKey(name));
  keys.delete('');
  return keys;
}

const trackArtists = (t: RadioMatchTrack): string[] => (t.artists?.length ? t.artists : [t.artist ?? '']).map((a) => String(a ?? '').trim()).filter(Boolean);

/** A catalogue track is the broadcast's song: the same title core and one of its artists credited by the station. */
export function radioSongFits(t: RadioMatchTrack | null | undefined, b: { title?: string | null; artist?: string | null } | null | undefined): boolean {
  if (!t || !b?.title || !b.artist) return false;
  if (parseTitle(t.title).core !== parseTitle(b.title).core) return false;
  const keys = radioArtistKeys(b.artist);
  return trackArtists(t).some((a) => keys.has(radioArtistKey(a)));
}

/**
 * What the artist link on a radio row opens. With a confident match for the same song, the
 * catalogue's artist that the station credited — with the provider's artist id when it is the
 * song's lead artist (the id services give belongs to the lead). Otherwise the cleaned primary name.
 */
export function radioArtistTarget(rawArtist: string | null | undefined, matched?: RadioMatchTrack | null, song?: { title?: string | null } | null): RadioArtistTarget | null {
  const primary = normaliseRadioArtist(rawArtist);
  if (matched && (!song?.title || radioSongFits(matched, { title: song.title, artist: rawArtist ?? null }))) {
    const keys = radioArtistKeys(rawArtist);
    const names = trackArtists(matched);
    const primaryKey = primary ? radioArtistKey(primary) : '';
    // The station's lead artist first; any other credited name only when the lead is not on the record.
    let i = names.findIndex((a) => radioArtistKey(a) === primaryKey);
    if (i < 0) i = names.findIndex((a) => keys.has(radioArtistKey(a)));
    if (i >= 0) {
      const name = names[i]!;
      const ids = i === 0 ? matched.artist_ids ?? {} : {};
      if (ids['deezer'] && DZ_ID.test(ids['deezer'])) return { id: `dz:${ids['deezer']}`, name };
      if (ids['ytmusic'] && YT_ARTIST.test(ids['ytmusic'])) return { id: `yt:${ids['ytmusic']}`, name };
      return { name };
    }
  }
  return primary ? { name: primary } : null;
}
