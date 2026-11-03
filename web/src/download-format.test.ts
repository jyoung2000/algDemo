import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DL_FORMATS } from './engine/downloads';

const ui = readFileSync(new URL('./Downloads.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

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
});

/**
 * Measured in the running app: at 390px the format <select> had room for about 303px of text, so
 * only two of the six explanatory labels fitted and the FLAC one needed 410px. A closed <select>
 * cannot wrap, so the names stay short and the explanation lives in a paragraph that can.
 */
describe('the format control fits a phone and still explains itself', () => {
  it('keeps the option names short', () => {
    for (const f of DL_FORMATS) {
      const m = new RegExp(`${f}: '([^']*)'`).exec(ui);
      expect(m, `no label for ${f}`).toBeTruthy();
      expect(m![1]!.length, `${f} label too long for a phone select`).toBeLessThanOrEqual(12);
    }
  });

  it('explains the chosen format in a paragraph that wraps', () => {
    expect(ui).toMatch(/const FORMAT_NOTE: Record<DlFormat, string>/);
    expect(ui).toContain('<p className="dl__note" id="dl-format-note">{FORMAT_NOTE[d.format]}</p>');
    expect(css).toMatch(/\.dl__note \{[^}]*max-width: 62ch;/);
  });

  it('ties the note to the select for a screen reader', () => {
    expect(ui).toMatch(/aria-describedby="dl-format-note"/);
  });

  it('says plainly that mp3 re-encodes and that flac and wav restore nothing', () => {
    expect(ui).toMatch(/mp3: 'Plays on anything, but re-encodes the audio and loses the top treble\.'/);
    expect(ui).toMatch(/flac: 'A lossless container\. It cannot restore detail the source already dropped/);
    expect(ui).toMatch(/wav: 'Uncompressed and very large\. It restores nothing the source dropped\.'/);
  });

  it('gives the download controls a 44px touch target', () => {
    expect(css).toMatch(/\.dl__lbl \.field \{[^}]*min-height: 44px;/);
  });
});
