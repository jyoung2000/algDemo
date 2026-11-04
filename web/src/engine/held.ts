import type { DlFile } from './downloads';

/** What the shell reports for a link. Older shells answer without the `kept`/`cached` split. */
export type HeldLookup = (url: string) => Promise<{
  file: DlFile | null;
  kept?: boolean;
  cached?: boolean;
  running: boolean;
  error?: string | null;
}>;

export interface HeldCopy { kept: true; file: DlFile | null }

/**
 * Does the shell already hold a PERMANENT copy of this link?
 *
 * Only a kept copy counts. A queue-cache entry is evictable, so reporting it as "already
 * downloaded" would promise the listener a file that can vanish. Any uncertainty — an older shell
 * with no `kept` field, no shell at all, or a failed call — answers "not held": one redundant file
 * is a smaller harm than refusing a download the listener asked for.
 */
export async function heldCopy(lookup: HeldLookup, url: string): Promise<HeldCopy | null> {
  try {
    const r = await lookup(url);
    // A running job owns this link already; the caller watches it rather than starting another.
    if (r.running) return null;
    return r.kept === true ? { kept: true, file: r.file ?? null } : null;
  } catch {
    return null;
  }
}
