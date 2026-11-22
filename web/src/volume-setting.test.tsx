// @vitest-environment happy-dom
// VOLUME-SETTINGS-001 (owner, 2026-11-22): "move the volume control for the app to the top of settings instead of in the
// player control and replace that with a button and icon to heart the current playing artist".
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VolumeSetting } from './VolumeSetting';
import { volumeStore } from './volume-store';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(join(here, f), 'utf8').replace(/\r\n/g, '\n');
beforeEach(() => { window.localStorage.clear(); volumeStore.setLimits(2, ''); volumeStore.set(0.8); });
afterEach(() => cleanup());

describe('the volume control in Settings', () => {
  it('is a slider always on show, with the level beside it', () => {
    render(<VolumeSetting />);
    const bar = screen.getByRole('slider', { name: 'Volume' }) as HTMLInputElement;
    expect(bar.value).toBe('80');
    expect(bar.max).toBe('200');
    expect(screen.getByText('80%')).toBeTruthy();
  });

  it('changes the app\u2019s level as it is moved, and shows a level set elsewhere', () => {
    render(<VolumeSetting />);
    const bar = screen.getByRole('slider', { name: 'Volume' }) as HTMLInputElement;
    fireEvent.change(bar, { target: { value: '35' } });
    expect(volumeStore.level()).toBe(0.35);
    // The car's Volume button, or the lock screen, moves it too.
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(volumeStore.muted()).toBe(true);
    expect((screen.getByRole('slider', { name: 'Volume' }) as HTMLInputElement).value).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
    expect(volumeStore.audible()).toBe(0.35);
  });

  it('says when it is boosted past normal volume, and stops at what the player can do', () => {
    volumeStore.set(1.5);
    const { container, rerender } = render(<VolumeSetting />);
    expect(screen.getByText('150%')).toBeTruthy();
    expect(container.querySelector('.volset')!.classList.contains('is-boosted')).toBe(true);
    expect((screen.getByRole('slider', { name: 'Volume' }) as HTMLInputElement).getAttribute('aria-valuetext')).toMatch(/boosted/);
    volumeStore.setLimits(1, '');
    rerender(<VolumeSetting />);
    expect((screen.getByRole('slider', { name: 'Volume' }) as HTMLInputElement).max).toBe('100');
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('is switched off, with the reason, when the playing source has its own volume', () => {
    volumeStore.setLimits(1, 'SoundCloud\u2019s player has its own volume control.');
    render(<VolumeSetting />);
    expect((screen.getByRole('slider', { name: 'Volume' }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/SoundCloud/)).toBeTruthy();
  });

  it('sits at the top of Settings, above Discovery', () => {
    const s = src('Settings.tsx');
    const at = s.indexOf('<VolumeSetting />');
    expect(at).toBeGreaterThan(s.indexOf('<h2 id="set-h">Settings</h2>'));
    expect(at).toBeLessThan(s.indexOf('<h3 id="discovery-h">Discovery</h3>'));
  });

  it('is in neither player any more', () => {
    for (const f of ['Player.tsx', 'RadioPlayer.tsx']) {
      expect(src(f), f).not.toMatch(/from '\.\/Volume'/);
      expect(src(f), f).not.toMatch(/<Volume\b/);
    }
  });
});
