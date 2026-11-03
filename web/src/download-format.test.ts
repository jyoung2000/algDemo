import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DL_FORMATS } from './engine/downloads';

const ui = readFileSync(new URL('./Downloads.tsx', import.meta.url), 'utf8');

/**
 * Measured on a real Android download of one track (2026-11-02): YouTube Music served Opus at
 * 163 kbps / 8,767,680 bytes with content to 20.1 kHz. Asking for MP3 produced 153 kbps /
 * 8,229,586 bytes cut off at 16.6 kHz — 6% smaller for an audible loss at the top end. So the
 * app defaults to the source bytes and never silently re-encodes.
 */
describe('downloads default to the format that cannot lose quality', () => {
  it('offers "original" first', () => {
    expect(DL_FORMATS[0]).toBe('original');
  });

  it('defaults to "original", not mp3', () => {
    expect(ui).toMatch(/return 'original';/);
    expect(ui).not.toMatch(/return 'mp3';/);
  });

  it('still offers every format the native shells accept', () => {
    expect([...DL_FORMATS].sort()).toEqual(['flac', 'm4a', 'mp3', 'opus', 'original', 'wav']);
  });

  it('tells the user which choices re-encode, so the tradeoff is not hidden', () => {
    expect(ui).toMatch(/original: 'Original — keeps the source audio, no quality lost'/);
    expect(ui).toMatch(/mp3: 'MP3 — plays anywhere, re-encodes and loses the top treble'/);
    // FLAC and WAV cannot resurrect what a lossy source already discarded; the labels must not imply they can.
    expect(ui).toMatch(/flac: 'FLAC — lossless container, but cannot restore what the source dropped'/);
    expect(ui).toMatch(/wav: 'WAV — uncompressed, very large, restores nothing'/);
  });
});
