/**
 * ICON-SPACING-001. Owner: "the arrows are too close on the shuffle and quick refresh icon". The shared
 * kit's shuffle put its two arrowheads 4.5 units apart on a 24-unit grid, and its refresh drew two arcs
 * whose heads sat side by side. These are drawn here (the kit belongs to the outer repo) as strokes:
 * the shuffle's heads sit 12 units apart, and refresh is one circular arrow with one head.
 */
interface Props {
  size?: number;
}

const svg = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
  focusable: 'false' as const,
});

/** Arrowhead tips at y=6 and y=18. */
export const SHUFFLE_PATHS = [
  'M4 6h1.5c1.6 0 2.6.7 3.4 1.9l6.2 8.2c.8 1.2 1.8 1.9 3.4 1.9H20',
  // The rising line passes under, broken 3.3 units either side of the centre (12,12): equal gaps.
  'M4 18h1.5c1.6 0 2.6-.7 3.4-1.9l1.1-1.45',
  'M14 9.35l1.1-1.45c.8-1.2 1.8-1.9 3.4-1.9H20',
  'M17 3l3 3-3 3',
  'M17 15l3 3-3 3',
] as const;

export function ShuffleGlyph({ size = 16 }: Props) {
  return (
    <svg className="glyph glyph--stroke" {...svg(size)}>
      {SHUFFLE_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** One arc, open at the top right, ending in its head's corner with a 4-unit opening to its tail. */
export const REFRESH_PATHS = ['M20 12a8 8 0 1 1-2.34-5.66L20 8', 'M20 3v5h-5'] as const;

export function RefreshGlyph({ size = 14 }: Props) {
  return (
    <svg className="glyph glyph--stroke" {...svg(size)}>
      {REFRESH_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** ALBUM-OPEN-001: a record, for the album button on song rows (the kit has no album glyph). */
export function AlbumGlyph({ size = 14 }: Props) {
  return (
    <svg className="glyph glyph--stroke" {...svg(size)}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M7.4 9.6a5.2 5.2 0 0 1 2.2-2.2" />
    </svg>
  );
}

/**
 * REPEAT-COUNT-001. Owner: "the repeat song icon has the arrows too close together and you cant
 * even tell its 2 arrows in a circle". Two arcs of 112 degrees on an 8.6-unit ring, each ending in
 * a solid head that points 24 degrees further round, then 44 degrees of nothing before the other
 * arrow starts. The heads sit at the lower right and upper left, which leaves the middle band of
 * the ring clear for the count. The count is drawn, not typed, so the phone, the desktop and the
 * car (res/drawable/car_repeat_*.xml carries these same strings) show one picture.
 */
export const REPEAT_ARCS = ['M16.04 4.41A8.6 8.6 0 0 1 17.53 18.59', 'M7.96 19.59A8.6 8.6 0 0 1 6.47 5.41'] as const;
export const REPEAT_HEADS = ['M19.2 20.58L14.37 20.27L15.86 16.6Z', 'M4.8 3.42L9.63 3.73L8.14 7.4Z'] as const;
/** What is still owed: one more play, two more plays, or every play ('one' is the saved name for infinity). */
export const REPEAT_MARKS = {
  once: ['M10.6 10.3L12.4 8.6L12.4 15.4'],
  twice: ['M9.8 10.4C9.8 8.2 14.2 8.2 14.2 10.5C14.2 12.2 11.6 13.4 9.7 15.4L14.5 15.4'],
  one: ['M12 12C10.6 9.9 7.6 9.7 7.6 12C7.6 14.3 10.6 14.1 12 12C13.4 9.9 16.4 9.7 16.4 12C16.4 14.3 13.4 14.1 12 12Z'],
} as const;

export function RepeatGlyph({ mode, size = 22 }: Props & { mode: 'off' | 'once' | 'twice' | 'one' | 'all' }) {
  const mark = mode === 'once' || mode === 'twice' || mode === 'one' ? REPEAT_MARKS[mode] : []; // off: an empty centre
  return (
    <svg className="glyph glyph--stroke" {...svg(size)} strokeWidth={1.9}>
      {REPEAT_ARCS.map((d) => <path key={d} d={d} />)}
      {REPEAT_HEADS.map((d) => <path key={d} d={d} fill="currentColor" strokeWidth={1} />)}
      {mark.map((d) => <path key={d} d={d} strokeWidth={1.8} />)}
    </svg>
  );
}

/**
 * SIMILAR-ICON-001 (owner, 2026-11-19): "Find similar sound" as an icon. A note sending out sound
 * waves: "more that sounds like this". The same drawing as the car's button (car_similar.xml).
 */
export const SIMILAR_PATHS = ['M8.8 17.6V4.6c1.7.4 3.2 1.5 3.2 3.4', 'M15 9a4.2 4.2 0 0 1 0 6', 'M18.2 6.2a8 8 0 0 1 0 11.6'] as const;
export function SimilarGlyph({ size = 16 }: Props) {
  return (
    <svg className="glyph glyph--stroke" {...svg(size)}>
      <circle cx="6.2" cy="17.6" r="2.6" fill="currentColor" stroke="none" />
      {SIMILAR_PATHS.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
