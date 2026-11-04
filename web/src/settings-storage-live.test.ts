import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const settings = readFileSync(join(__dirname, 'Settings.tsx'), 'utf8');

describe('the storage meter reports live truth', () => {
  it('re-reads storage while the panel is open, not only once on mount', () => {
    // Measured on Windows 0.6.1: the meter said "381 MB of 1.07 GB" for 125 s while the shell
    // already held a 3 GB limit, because the only fetch was `useEffect(() => load(false), [])`.
    // A storage meter that cannot change is a screenshot, not a meter.
    // Match the CALL, not the `ReturnType<typeof setInterval>` type annotation.
    expect(settings).toMatch(/=\s*setInterval\(/);
    expect(settings).toMatch(/setInterval\(\s*\(\)\s*=>[\s\S]{0,120}?refreshStorage\(\)/);
  });

  it('clears its timer when the panel closes, so a hidden screen stops polling the shell', () => {
    expect(settings).toMatch(/clearInterval\(timer\)/);
    // The effect must return a cleanup that stops it; an uncleaned timer leaks past unmount.
    expect(settings).toMatch(/return \(\) =>[\s\S]{0,160}?stop\(\)/);
    // And a hidden tab must not keep waking the shell.
    expect(settings).toMatch(/visibilitychange/);
    expect(settings).toMatch(/document\.hidden/);
  });

  it('re-reads immediately after the cache limit is changed rather than waiting for the next tick', () => {
    // Dragging the GB slider must move the "of N GB" denominator at once; waiting feels broken.
    expect(settings).toMatch(/cache_gb: Number\(e\.target\.value\)[\s\S]{0,80}?refreshStorage\(\)/);
  });

  it('polls quietly: no spinner flag and no error banner from a background refresh', () => {
    // A 4 s poll that sets `checking` or clears `err` would flicker the panel and could blank a
    // real message the listener is reading.
    const fn = settings.slice(settings.indexOf('const refreshStorage'), settings.indexOf('const load ='));
    expect(fn).toMatch(/api\.status\(\)/);
    expect(fn).not.toMatch(/setChecking|setErr/);
  });

  it('shows the shell cache figure, never the WebView storage estimate', () => {
    // STORAGE-TRUTH-001: navigator.storage.estimate() is blind to the shell's private cache.
    expect(settings).toMatch(/queue_audio/);
    expect(settings).not.toMatch(/navigator\.storage\.estimate/);
  });
});
