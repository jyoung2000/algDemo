import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ui = readFileSync(new URL('./Downloads.tsx', import.meta.url), 'utf8');

/**
 * The listener's explicit Download must never destroy the copy the player is streaming, and it must
 * not report failure when a shell keeps the song synchronously. Windows answers `keep` with a job;
 * Android copies the cached file itself and answers `{ok, saved_to}` with no job. Both are success.
 */
describe('Download keeps a permanent copy without disturbing playback', () => {
  it('tries keep before starting a second download of the same song', () => {
    expect(ui).toMatch(/const kept = await dl\.keep\(url\)/);
    expect(ui.indexOf('await dl.keep(url)')).toBeLessThan(ui.indexOf('await dl.start(url, tool, format, label)'));
  });

  it('treats a job-less keep as a finished download instead of an error', () => {
    expect(ui).toMatch(/if \(kept\?\.ok\)/);
    expect(ui).toMatch(/state: 'done', stage: 'done', percent: 100/);
    expect(ui).toMatch(/satisfies DlJob/);
  });

  it('checks for a copy already on disk before starting any download, for every tool', () => {
    // The yt-dlp/original `keep` path below is narrower than the duplicate bug: a spotdl song took
    // neither branch and was refetched. This check must stay ahead of every dl.start call.
    expect(ui).toMatch(/const already = await heldCopy\(/);
    expect(ui.indexOf('await heldCopy(')).toBeLessThan(ui.indexOf("if (tool === 'yt-dlp' && format === 'original')"));
    expect(ui.indexOf('await heldCopy(')).toBeLessThan(ui.indexOf('await dl.start(url, tool, format, label)'));
  });

  it('never cancels or deletes the playing cache entry from the download path', () => {
    expect(ui).not.toMatch(/dl\.cancel\([^)]*\)\s*;?\s*\/\/\s*keep/);
    expect(ui).not.toMatch(/op: 'forget'/);
  });

  it('offers a destination folder change that only affects later downloads', () => {
    expect(ui).toMatch(/dl\.chooseFolder\(\)/);
    expect(ui).toMatch(/Change folder/);
  });
});
