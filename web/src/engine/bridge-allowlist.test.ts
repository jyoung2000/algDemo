/**
 * The page-side guard (net.ts), the Android bridge (MainActivity.kt) and the Windows bridge
 * (windows/hosts.cjs) each hold a copy of the host allowlist. They must be the same list, or one app
 * could reach a host the other refuses.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ALLOWED_HOSTS, ALLOWED_SUFFIXES } from './net';

const root = new URL('../../../', import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, root), 'utf8');
const quoted = (block: string): string[] => [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);

describe('bridge allowlists match net.ts', () => {
  it('Android HOSTS and SUFFIXES', () => {
    const kt = read('android/app/src/main/java/com/nowplaying/discovery/MainActivity.kt');
    const hosts = quoted(/val HOSTS = setOf\(([\s\S]*?)\n\s*\)/.exec(kt)?.[1] ?? '');
    const suffixes = quoted(/val SUFFIXES = listOf\(([^)]*)\)/.exec(kt)?.[1] ?? '');
    expect(new Set(hosts)).toEqual(new Set(ALLOWED_HOSTS));
    expect(suffixes).toEqual([...ALLOWED_SUFFIXES]);
  });

  it('Windows HOSTS and SUFFIXES', () => {
    const win = createRequire(import.meta.url)(new URL('windows/hosts.cjs', root).pathname.replace(/^\/([A-Za-z]:)/, '$1')) as { HOSTS: string[]; SUFFIXES: string[] };
    expect(new Set(win.HOSTS)).toEqual(new Set(ALLOWED_HOSTS));
    expect(win.SUFFIXES).toEqual([...ALLOWED_SUFFIXES]);
  });
});
