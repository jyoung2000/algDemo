import type { ReactNode } from 'react';

/**
 * ARTIST-SRC-ICON-001 — owner: "ensure the platforms and sources have there respective app icons & colors".
 *
 * One mark per source, drawn the same on every screen: a flat rounded tile in the platform's own colour
 * with a plain white glyph. It replaces the window kit's ProviderMark here because that one is a glossy
 * Aqua tile, paints Deezer grey, and knows nothing of YouTube Music, Audius, HearThis, Internet Archive or
 * Apple Music, which all fell through to a grey tile with a letter on it.
 *
 * These are NOT the platforms' logos, on purpose. The kit's note (packages/aqua-ui/src/icons/
 * provider-marks.tsx) records why: every one of these platforms publishes brand terms that say to use
 * their official file and not to redraw it. A colour is not a trademark, so each tile is the platform's
 * colour and the glyph says what the platform is (a triangle for video, a cloud for SoundCloud's
 * namesake). To show the real logos, the official files have to be supplied by someone who has accepted
 * those terms.
 */
export interface SourceMarkSpec {
  /** The platform's own colour; neutral where it has none to speak of. */
  colour: string;
  glyph: SourceGlyph;
}
type SourceGlyph = 'play' | 'cloud' | 'bars' | 'tag' | 'note' | 'metronome' | 'columns' | 'wave' | 'ring' | 'device';

export const SOURCE_MARKS: Readonly<Record<string, SourceMarkSpec>> = {
  deezer: { colour: '#A238FF', glyph: 'metronome' },
  ytmusic: { colour: '#FF0000', glyph: 'play' },
  soundcloud: { colour: '#FF5500', glyph: 'cloud' },
  bandcamp: { colour: '#1DA0C3', glyph: 'tag' },
  audius: { colour: '#CC0FE0', glyph: 'wave' },
  // HearThis publishes no colour of its own that could be confirmed; it gets a slate tile.
  hearthis: { colour: '#3D4A5C', glyph: 'ring' },
  archive: { colour: '#2C2C2C', glyph: 'columns' },
  spotify: { colour: '#1DB954', glyph: 'bars' },
  apple: { colour: '#FA243C', glyph: 'note' },
  local: { colour: '#6D7986', glyph: 'device' },
  radio: { colour: '#0071E3', glyph: 'wave' },
};
/** Ids other parts of the app use for the same source. */
const ALIAS: Readonly<Record<string, string>> = { youtube: 'ytmusic', 'youtube-music': 'ytmusic', itunes: 'apple', 'apple-music': 'apple' };
const NEUTRAL = '#6A717A';

function initialsOf(provider: string): string {
  return provider.split(/[-_ ]+/).map((part) => part.charAt(0).toUpperCase()).join('').slice(0, 2) || 'P';
}

const GLYPHS: Readonly<Record<SourceGlyph, ReactNode>> = {
  play: <path d="M6.1 4.5 11.9 8l-5.8 3.5z" fill="#fff" />,
  cloud: <path d="M5.1 11.4a2.3 2.3 0 0 1-.3-4.58A3.3 3.3 0 0 1 11.1 6.1a2.67 2.67 0 0 1 .5 5.3z" fill="#fff" />,
  bars: (
    <g fill="#fff">
      <rect x="3.6" y="7.6" width="2" height="4.8" rx="0.6" />
      <rect x="7" y="3.6" width="2" height="8.8" rx="0.6" />
      <rect x="10.4" y="5.8" width="2" height="6.6" rx="0.6" />
    </g>
  ),
  tag: <path d="M4.2 11.6 7.9 4.4h3.9L8.1 11.6z" fill="#fff" />,
  note: (
    <g fill="#fff">
      <path d="M6.6 3.9 11.6 3v6.9h-1.2V5.3L7.8 5.8v5.3H6.6z" />
      <ellipse cx="5.9" cy="11.2" rx="1.75" ry="1.35" />
      <ellipse cx="10.5" cy="10" rx="1.75" ry="1.35" />
    </g>
  ),
  metronome: (
    <g>
      <path d="M6.6 3.4h2.8l2.3 9.1H4.3z" fill="#fff" />
      <path d="M8 10.6 10.9 4.2" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </g>
  ),
  columns: (
    <g fill="#fff">
      <path d="M8 3 13 5.4v.9H3v-.9z" />
      <rect x="4" y="7" width="1.5" height="4" />
      <rect x="7.25" y="7" width="1.5" height="4" />
      <rect x="10.5" y="7" width="1.5" height="4" />
      <rect x="3" y="11.6" width="10" height="1.3" />
    </g>
  ),
  wave: <path d="M3.2 8h1.6l1.3-3.4 2 6.8 1.7-5 1 1.6h2" fill="none" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
  ring: (
    <g fill="none" stroke="#fff" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="8" cy="8" r="1.5" fill="#fff" stroke="none" />
      <path d="M5.3 5.3a3.8 3.8 0 0 0 0 5.4M10.7 5.3a3.8 3.8 0 0 1 0 5.4" />
    </g>
  ),
  device: (
    <g fill="#fff">
      <path d="M6.9 3.6 11.4 2.8v6.7h-1.2V5.1L8.1 5.5v5.2H6.9z" />
      <ellipse cx="6.2" cy="10.8" rx="1.7" ry="1.3" />
      <ellipse cx="10.4" cy="9.6" rx="1.7" ry="1.3" />
    </g>
  ),
};

/** The mark for a source. Decorative unless given a title: the source's name is always written beside it. */
export function SourceMark({ provider, size = 16, title, className }: { provider: string; size?: number; title?: string; className?: string }) {
  const id = ALIAS[provider] ?? provider;
  const spec = SOURCE_MARKS[id];
  const initials = spec ? '' : initialsOf(provider);
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={['aqua-icon', 'aqua-icon--provider', 'srcmark', className].filter(Boolean).join(' ')}
      data-provider={id}
      // The metronome's arm is the tile's colour showing through.
      color={spec?.colour ?? NEUTRAL}
      focusable="false"
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      {title ? <title>{title}</title> : null}
      <rect width="16" height="16" rx="3.6" fill={spec?.colour ?? NEUTRAL} />
      {spec ? GLYPHS[spec.glyph] : (
        <text x="8" y="8" textAnchor="middle" dominantBaseline="central" fontSize={initials.length > 1 ? 7 : 9} fontWeight="700" fill="#fff">
          {initials}
        </text>
      )}
    </svg>
  );
}
