/**
 * One key for a song however a service dresses its title: the title without "(feat. ...)" or
 * brackets, and the versions it names (live, remix, acoustic), so a live take is not the studio one.
 * Used where an artist page lists one song from several services (ARTIST-ALL-SOURCES-001).
 */
import { parseTitle } from './identity';

export function songKey(t: { title: string }): string {
  const p = parseTitle(t.title);
  return `${p.core}|${[...p.versions].sort().join(',')}`;
}
