import type { ResultType } from './result-types';

/**
 * RESULT-TYPES-001: a small row of icon toggles that narrows a list of results to the kinds chosen.
 * Nothing chosen shows everything; each icon toggles on and off (aria-pressed), and several can be
 * on at once. Icons: one person for artists (search only), a CD for singles, an album cover for
 * albums, two people for features, a music note for lyric matches (search) or the artist's own songs
 * (discography).
 */
const LABEL: Record<ResultType, { name: string; tip: string }> = {
  artists: { name: 'Artists', tip: 'Show only the artist and their songs' },
  singles: { name: 'Singles', tip: 'Show only singles' },
  albums: { name: 'Albums', tip: 'Show only albums and album songs' },
  features: { name: 'Features', tip: 'Show only songs with featured artists' },
  lyrics: { name: 'Lyrics', tip: 'Show only songs matched by their lyrics' },
  songs: { name: 'Songs', tip: 'Show only songs' },
};

export function TypeIcon({ type, size = 18 }: { type: ResultType; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (type) {
    case 'artists': // one person
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.6" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </svg>
      );
    case 'singles': // a CD
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="2.4" />
          <path d="M12 5.2a6.8 6.8 0 0 1 6.8 6.8" opacity="0.55" />
        </svg>
      );
    case 'albums': // an album cover with a record peeking out
      return (
        <svg {...common}>
          <rect x="3" y="4" width="13" height="16" rx="1.6" />
          <path d="M16 6.6a5.4 5.4 0 0 1 0 10.8" />
          <circle cx="9.5" cy="12" r="2.6" />
        </svg>
      );
    case 'features': // two people
      return (
        <svg {...common}>
          <circle cx="9" cy="8.5" r="3" />
          <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
          <circle cx="16.5" cy="9.5" r="2.5" />
          <path d="M15.2 14.3a4.6 4.6 0 0 1 5.8 4.7" />
        </svg>
      );
    default: // a music note (lyrics in search, songs on an artist page)
      return (
        <svg {...common}>
          <path d="M9 18V5.5l11-2V16" />
          <circle cx="6.5" cy="18" r="2.5" />
          <circle cx="17.5" cy="16" r="2.5" />
        </svg>
      );
  }
}

export function TypeFilter({ types, selected, onToggle, counts }: {
  types: readonly ResultType[];
  selected: ReadonlySet<ResultType>;
  onToggle: (t: ResultType) => void;
  /** How many results of each kind there are, shown in the tooltip; a kind with none is dimmed. */
  counts?: Partial<Record<ResultType, number>>;
}) {
  return (
    <div className="typefilter" role="group" aria-label="Show only">
      {types.map((t) => {
        const on = selected.has(t);
        const n = counts?.[t];
        const label = `${LABEL[t].name}${n != null ? ` (${n})` : ''}`;
        return (
          <button
            key={t}
            type="button"
            className={`typefilter__btn${on ? ' is-on' : ''}${n === 0 && !on ? ' is-empty' : ''}`}
            data-type={t}
            aria-pressed={on}
            aria-label={on ? `${label}: showing only these. Tap again to show everything` : `${label}: ${LABEL[t].tip.toLowerCase()}`}
            title={on ? `${LABEL[t].name} — tap again to show everything` : LABEL[t].tip}
            onClick={() => onToggle(t)}
          >
            <TypeIcon type={t} />
          </button>
        );
      })}
    </div>
  );
}

/** Toggle one kind in a selection set (returns a new set). */
export function toggleType(set: ReadonlySet<ResultType>, t: ResultType): Set<ResultType> {
  const next = new Set(set);
  if (next.has(t)) next.delete(t);
  else next.add(t);
  return next;
}
