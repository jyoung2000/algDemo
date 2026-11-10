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
