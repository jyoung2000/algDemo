// @vitest-environment happy-dom
// DOCK-CENTRE-001 / ALBUM-NO-X-001 (owner, 2026-11-19): the phone row puts previous, play and next in the middle;
// an album playing has no X (Dislike) on the player.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { PlayerActions, type TrackActionProps } from './PlayerActions';

afterEach(cleanup);
const here = dirname(fileURLToPath(import.meta.url));
const base: TrackActionProps = { flags: {}, downloadState: 'idle', downloadAvailable: true, onFeedback: async () => {}, onDownload: async () => true, onDownloads: () => {}, onSimilar: () => {} };
const labels = (c: HTMLElement) => [...c.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));

describe('the player actions', () => {
  it('an album playing has no Dislike (X); everything else stays', () => {
    const { container } = render(createElement(PlayerActions, { ...base, noDislike: true }));
    expect(labels(container)).not.toContain('Dislike this song');
    expect(labels(container)).toEqual(expect.arrayContaining(['Like this song', 'Download this song', 'Find similar songs to this one']));
  });
  it('the phone row can split them either side of play', () => {
    const judge = render(createElement(PlayerActions, { ...base, only: ['star', 'dislike'] }));
    expect(labels(judge.container)).toEqual(['Like this song', 'Dislike this song']);
    cleanup();
    const keep = render(createElement(PlayerActions, { ...base, only: ['download', 'similar'] }));
    expect(labels(keep.container)).toEqual(['Download this song', 'Find similar songs to this one']);
  });
  it('while the chosen song opens they wait (PLAYER-TRUTH-001)', () => {
    const { container } = render(createElement(PlayerActions, { ...base, held: true }));
    expect(container.querySelector('.np__track-actions')!.classList.contains('np__actions-held')).toBe(true);
  });
});

describe('the phone row', () => {
  const player = readFileSync(join(here, 'Player.tsx'), 'utf8');
  const css = readFileSync(join(here, 'dock-centre.css'), 'utf8');
  it('is three parts with previous, play and next in the middle', () => {
    const dock = /<div className="np__controls np__controls--centred">([\s\S]*?)\n              <\/div>/.exec(player)![1]!;
    const mid = /<div className="transport np__ctl-mid"[^>]*>([\s\S]*?)<\/div>/.exec(dock)![1]!;
    expect(mid.replace(/\s+/g, '')).toBe('{prevBtn}{playBtn}{nextBtn}');
    expect(dock.indexOf('np__ctl-side--start')).toBeLessThan(dock.indexOf('np__ctl-mid'));
    expect(dock.indexOf('np__ctl-mid')).toBeLessThan(dock.indexOf('np__ctl-side--end'));
  });
  it('the sides are equal columns, so play is exactly in the middle', () => {
    expect(css).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/);
    expect(player).toMatch(/import '\.\/dock-centre\.css';/);
    expect(player.indexOf("import './dock-centre.css'")).toBeGreaterThan(player.indexOf("import './player-inline.css'"));
  });
});
