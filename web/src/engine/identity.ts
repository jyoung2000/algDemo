/**
 * Recording identity: normalisation, version tokens, collaborations and conservative matching.
 * TypeScript port of server/airwave_discovery/identity.py. Two rows are merged only when they are the
 * same recording with high confidence; close-but-not-certain pairs come back as "uncertain".
 */

// Version tokens that make a different recording (or a different rendition of one).
const VERSION_PATTERNS: [string, RegExp][] = [
  ['live', /\blive\b|\bunplugged\b|\bin concert\b/],
  ['acoustic', /\bacoustic\b/],
  ['remix', /\bremix\b|\brmx\b|\bmix\)|\bedit\b(?! version)|\bflip\b|\bbootleg\b|\brework\b|\bvip\b/],
  ['sped-up', /\bsped[\s-]?up\b|\bspeed[\s-]?up\b|\bnightcore\b/],
  ['slowed', /\bslowed\b|\breverb\b/],
  ['cover', /\bcover\b|\btribute\b/],
  ['instrumental', /\binstrumental\b|\bkaraoke\b|\boff vocal\b/],
  ['demo', /\bdemo\b/],
  ['extended', /\bextended\b|\bclub mix\b|\b12 inch\b/],
  ['radio-edit', /\bradio edit\b|\bradio version\b|\bsingle version\b/],
  ['orchestral', /\borchestral\b|\bsymphonic\b/],
  ['a-cappella', /\ba ?cappella\b/],
];
// Edition words: shown to the user, but a remaster is the same performance, so they do not block a match.
const EDITION_PATTERN = /\bremaster(ed)?\b|\b(19|20)\d\d (remaster|version|mix)\b|\bdeluxe\b|\bmono\b|\bstereo\b|\bexplicit\b|\bclean\b/;

const FEAT_PATTERN = /[([]?\s*\b(feat\.?|ft\.?|featuring|with)\s+([^)\]]+)[)\]]?/gi;
const BRACKETS = /[([]([^)\]]*)[)\]]/g;
const DASH_SUFFIX = /\s[-–—]\s(.+)$/;
const ARTIST_SPLIT = /\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bvs\.?|\/|;)\s*/i;

/** Lower-case, strip accents, keep letters/digits of any script, collapse spaces. */
export function fold(text: string): string {
  let t = (text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  t = t.replace(/&/g, ' and ').replace(/’/g, "'");
  t = t.replace(/[^\p{L}\p{N}_\s]/gu, ' ');
  t = t.replace(/_/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

export function splitArtists(names: string[] | string): string[] {
  const items = typeof names === 'string' ? [names] : [...names];
  const out: string[] = [];
  for (const item of items) {
    for (const part of (item || '').split(ARTIST_SPLIT)) {
      const f = fold(part);
      if (f && !out.includes(f)) out.push(f);
    }
  }
  return out;
}

export interface ParsedTitle {
  core: string; // folded title without version/feature decorations
  versions: Set<string>;
  edition: string | null;
  featured: string[];
  displayVersion: string | null;
}

const matchAll = (re: RegExp, s: string): RegExpMatchArray[] => [...s.matchAll(new RegExp(re.source, re.flags))];

export function parseTitle(title: string, extraVersion = ''): ParsedTitle {
  const raw = `${title || ''} ${extraVersion || ''}`.trim();
  const featured: string[] = [];
  for (const m of matchAll(FEAT_PATTERN, raw)) featured.push(...splitArtists(m[2] ?? ''));
  const bracketHits = matchAll(BRACKETS, raw).map((m) => m[1] ?? '');
  let decorations = bracketHits.join(' ');
  const dash = DASH_SUFFIX.exec(title || '');
  if (dash) decorations += ' ' + (dash[1] ?? '');
  const decFold = fold(decorations);
  const versions = new Set(VERSION_PATTERNS.filter(([, pat]) => pat.test(decFold)).map(([name]) => name));
  const editionM = EDITION_PATTERN.exec(decFold);
  let core = (title || '').replace(new RegExp(BRACKETS.source, 'g'), ' ');
  core = core.replace(new RegExp(FEAT_PATTERN.source, 'gi'), ' ');
  if (dash && (versions.size > 0 || editionM || /remaster|version|mix|edit|live/i.test(dash[1] ?? ''))) {
    core = core.replace(new RegExp(DASH_SUFFIX.source), '');
  }
  const shown: string[] = [];
  for (const p of bracketHits.map((x) => x.trim())) {
    if (p && !new RegExp('^(' + FEAT_PATTERN.source + ')', 'i').test('(' + p + ')')) shown.push(p);
  }
  const ev = (extraVersion || '').replace(/^[ ()[\]]+|[ ()[\]]+$/g, '');
  if (ev && !shown.includes(extraVersion.trim())) shown.push(ev);
  return {
    core: fold(core),
    versions,
    edition: editionM ? editionM[0] : null,
    featured,
    displayVersion: [...new Set(shown)].join(', ') || null,
  };
}

/** Stable key for dedupe: primary artist + title core + sorted version tokens. */
export function recordingKey(title: string, artists: string[], extraVersion = ''): string {
  const p = parseTitle(title, extraVersion);
  const names = splitArtists(artists);
  const primary = names[0] ?? '';
  return `${primary}|${p.core}|${[...p.versions].sort().join(',')}`;
}

export type Verdict = 'same' | 'uncertain' | 'different';
export interface MatchResult {
  verdict: Verdict;
  reason: string;
}

export interface TrackLike {
  title?: string;
  artists?: string[];
  duration?: number | null;
  isrc?: string | null;
  version?: string | null;
}

const setEq = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Compare two tracks (title, artists, duration, isrc, version). */
export function matchRecordings(a: TrackLike, b: TrackLike): MatchResult {
  const pa = parseTitle(a.title ?? '', a.version ?? '');
  const pb = parseTitle(b.title ?? '', b.version ?? '');
  // A shared ISRC is strong evidence, but providers do misfile them onto re-releases and live cuts.
  // Hard contradictions (a version tag or a duration that cannot be the same recording) win, so the
  // shortcut can never certify a different recording as the requested full song (SOURCE-ISRC-001).
  if (a.isrc && b.isrc && a.isrc.toUpperCase() === b.isrc.toUpperCase()) {
    if (!setEq(pa.versions, pb.versions)) {
      const diff = [...pa.versions].filter((x) => !pb.versions.has(x)).concat([...pb.versions].filter((x) => !pa.versions.has(x))).sort();
      return { verdict: 'different', reason: `same ISRC but different version (${diff.join(', ')})` };
    }
    const ia = a.duration, ib = b.duration;
    if (ia && ib) {
      const gap = Math.abs(Number(ia) - Number(ib));
      if (gap > 8) return { verdict: 'different', reason: `same ISRC but durations differ by ${Math.round(gap)}s` };
      if (gap > 3) return { verdict: 'uncertain', reason: `same ISRC but durations differ by ${Math.round(gap)}s` };
    }
    return { verdict: 'same', reason: 'same ISRC' };
  }
  const artsA = new Set([...splitArtists(a.artists ?? []), ...pa.featured]);
  const artsB = new Set([...splitArtists(b.artists ?? []), ...pb.featured]);
  if (![...artsA].some((x) => artsB.has(x))) return { verdict: 'different', reason: 'no shared artist' };
  let titleExact = true;
  if (pa.core !== pb.core) {
    const ta = new Set(pa.core.split(' ').filter(Boolean));
    const tb = new Set(pb.core.split(' ').filter(Boolean));
    const union = new Set([...ta, ...tb]);
    const inter = [...ta].filter((x) => tb.has(x)).length;
    if (ta.size === 0 || tb.size === 0 || inter / union.size < 0.75) return { verdict: 'different', reason: 'different title' };
    titleExact = false;
  }
  if (!setEq(pa.versions, pb.versions)) {
    const diff = [...pa.versions].filter((x) => !pb.versions.has(x)).concat([...pb.versions].filter((x) => !pa.versions.has(x))).sort();
    return { verdict: 'different', reason: `different version (${diff.join(', ')})` };
  }
  const da = a.duration, db = b.duration;
  if (da && db) {
    const diff = Math.abs(Number(da) - Number(db));
    if (diff <= 3 && titleExact) return { verdict: 'same', reason: `same title, artist and version; durations within ${Math.round(diff)}s` };
    if (diff <= 8) return { verdict: 'uncertain', reason: `durations differ by ${Math.round(diff)}s` };
    return { verdict: 'different', reason: `durations differ by ${Math.round(diff)}s` };
  }
  return { verdict: 'uncertain', reason: titleExact ? 'no duration to compare' : 'titles differ slightly' };
}
