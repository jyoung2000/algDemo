// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moodTint } from './brand-tint';
import { BrandLogo } from './BrandLogo';
import { pickerColorFor } from './util';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const src = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

/** JPLAY-BRAND-001 (owner, 2026-11-19): the app is jPlay, with the owner's logo, tinted by the listening mood. */
describe('the app is called jPlay (JPLAY-BRAND-001)', () => {
  it('shows jPlay, never the old name, wherever the app names itself', () => {
    expect(src('index.html')).toMatch(/<title>jPlay<\/title>/);
    for (const f of ['index.html', 'src/App.tsx', 'src/Search.tsx', 'src/main.tsx', 'src/engine/media-native.ts', 'src/engine/downloads.ts']) {
      // A stored folder path may keep the old name (it is where earlier downloads are); text the app shows may not.
      expect(src(f).replace(/Music[^'"`\n]*Airwave Discovery/g, ''), f).not.toMatch(/Airwave Discovery/);
    }
  });
});

describe('the logo takes the listening mood colour', () => {
  const rap = pickerColorFor('Rap')!;
  it('uses the colour of the genre leading the mood', () => {
    expect(rap).toMatch(/^#/);
    expect(moodTint({ leading: ['Rap', 'Electronic'], confidence: 0.6 }, null)).toBe(rap);
  });
  it('falls back to the song playing when the mood has too little to go on, or names no picker genre', () => {
    const playing = { color: '#ff8800' } as never;
    expect(moodTint({ leading: ['Rap'], confidence: 0.05 }, playing)).toBe('#ff8800');
    expect(moodTint({ leading: ['Not a genre at all'], confidence: 0.9 }, playing)).toBe('#ff8800');
    expect(moodTint(null, { families: [{ family: 'Rock', subgenre: null, color: '#aa0000' }] } as never)).toBe('#aa0000');
  });
  it('stays the logo\'s own grey with nothing playing and no mood', () => {
    expect(moodTint(null, null)).toBeNull();
    expect(moodTint({ leading: [], confidence: 0 }, null)).toBeNull();
  });
});

describe('BrandLogo', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it('draws the owner\'s mark and wordmark, named jPlay, tinted with the colour it is given', async () => {
    await act(async () => { root.render(<BrandLogo tint="#c4d872" />); });
    const logo = host.querySelector('.brandlogo') as HTMLElement;
    expect(logo.getAttribute('role')).toBe('img');
    expect(logo.getAttribute('aria-label')).toBe('jPlay');
    expect(logo.classList.contains('is-tinted')).toBe(true);
    expect(logo.style.getPropertyValue('--brand-tint')).toBe('#c4d872');
    expect(host.querySelector('.brandlogo__mark')).toBeTruthy();
    expect(host.querySelector('.brandlogo__word')).toBeTruthy();
  });
  it('is plain grey without a tint', async () => {
    await act(async () => { root.render(<BrandLogo tint={null} />); });
    const logo = host.querySelector('.brandlogo') as HTMLElement;
    expect(logo.classList.contains('is-tinted')).toBe(false);
  });
});
