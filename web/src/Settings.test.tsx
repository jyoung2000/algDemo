// @vitest-environment happy-dom
import profileSource from './Profile.tsx?raw';
import settingsSource from './Settings.tsx?raw';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SettingsView } from './Settings';
import type { Settings } from './api';

vi.mock('./api', () => ({
  api: {
    health: () => new Promise(() => {}),
    status: () => new Promise(() => {}),
  },
}));
vi.mock('./MicSettings', () => ({ MicSettings: () => null }));
afterEach(cleanup);
const saved: Settings = {
  fresh: false,
  adventurous: 0.5,
  audio: true,
  daily_mb: 100,
  request_mb: 20,
  sample_mode: false,
};
const props = (settings: Settings | null = saved, onSettings = vi.fn()) => ({
  settings,
  onSettings,
  onReset: vi.fn(),
  onResetTaste: vi.fn(),
});
const slider = () =>
  screen.getByRole('slider', { name: 'New songs per discovery' }) as HTMLInputElement;
const listening = () =>
  screen.getByRole('checkbox', { name: 'Discover while listening' }) as HTMLInputElement;

describe('Settings discovery controls', () => {
  it('puts Discovery before ranking and provides accessible bounds, output and description', () => {
    const { container } = render(<SettingsView {...props()} />);
    const section = screen.getByRole('region', { name: 'Discovery' });
    expect(within(section).getByRole('slider')).toBe(slider());
    expect(container.textContent!.indexOf('Discovery')).toBeLessThan(
      container.textContent!.indexOf('Ranking engine'),
    );
    expect([slider().min, slider().max, slider().step, slider().value]).toEqual([
      '5',
      '60',
      '1',
      '30',
    ]);
    const output = within(section).getByText('Up to 30 new songs per discovery');
    expect(output.tagName).toBe('OUTPUT');
    expect(output.getAttribute('for')).toBe(slider().id);
    expect(slider().getAttribute('aria-describedby')!.split(' ')).toContain(output.id);
    const help = document.getElementById('discovery-size-help')!;
    expect(slider().getAttribute('aria-describedby')!.split(' ')).toContain(help.id);
    expect(help.textContent).toMatch(/discovery may add/);
    expect(help.textContent).toMatch(/searched|listened/);
    expect(help.textContent).toMatch(/never removed/);
    expect(help.textContent).toMatch(/fewer/);
  });

  it('draws every checkbox: the Aqua gel box is a sibling span, not the hidden input', () => {
    // `.chk input` is opacity:0 by design (airwave-window.css:284); the visible control is the
    // sibling `.box` span. Without it the row renders as bare text and cannot be seen or aimed at.
    render(<SettingsView {...props()} />);
    const boxes = document.querySelectorAll('.chk input[type=checkbox]');
    expect(boxes.length).toBeGreaterThanOrEqual(4);
    for (const input of boxes) {
      expect(input.nextElementSibling?.classList.contains('box')).toBe(true);
    }
  });

  it('uses 30 and enabled for missing settings without saving over an existing value on mount', () => {
    const onSettings = vi.fn();
    const { rerender } = render(<SettingsView {...props(null, onSettings)} />);
    expect(slider().value).toBe('30');
    expect(listening().checked).toBe(true);
    rerender(
      <SettingsView
        {...props({ ...saved, queue_size: 47, discover_while_listening: false }, onSettings)}
      />,
    );
    expect(slider().value).toBe('47');
    expect(listening().checked).toBe(false);
    expect(onSettings).not.toHaveBeenCalled();
  });

  it.each([5, 31, 60])('saves %i immediately on change, without pointer-up or blur', (value) => {
    const onSettings = vi.fn();
    const { rerender } = render(<SettingsView {...props(saved, onSettings)} />);
    fireEvent.change(slider(), { target: { value: String(value) } });
    expect(onSettings).toHaveBeenCalledExactlyOnceWith({ queue_size: value });
    rerender(<SettingsView {...props({ ...saved, queue_size: value }, onSettings)} />);
    expect(screen.getByText(`Up to ${value} new songs per discovery`)).toBeTruthy();
  });

  it('saves explicit opt-out and opt-in and explains the listening trigger', () => {
    const onSettings = vi.fn();
    const { rerender } = render(<SettingsView {...props(saved, onSettings)} />);
    fireEvent.click(listening());
    expect(onSettings).toHaveBeenLastCalledWith({ discover_while_listening: false });
    rerender(
      <SettingsView {...props({ ...saved, discover_while_listening: false }, onSettings)} />,
    );
    fireEvent.click(listening());
    expect(onSettings).toHaveBeenLastCalledWith({ discover_while_listening: true });
    const help = document.getElementById(listening().getAttribute('aria-describedby')!)!;
    expect(help.textContent).toMatch(/finish one from your list/);
    expect(help.textContent).toMatch(/3 or fewer unplayed/);
    expect(help.textContent).toMatch(/never starts a search on its own/);
  });

  it('calls the allowance a discovery batch and keeps Profile terminology aligned', () => {
    render(<SettingsView {...props()} />);
    expect(screen.getByText(/MB for each discovery batch/)).toBeTruthy();
    expect(screen.queryByText('Per request')).toBeNull();
    expect(profileSource).toContain('<dt>New songs per discovery</dt>');
  });

  it('reuses Aqua dial thumbs with scoped 44px targets, wrapping and visible keyboard focus', () => {
    render(<SettingsView {...props()} />);
    expect(slider().closest('.dial')).not.toBeNull();
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'discovery-settings.css'),
      'utf8',
    );
    expect(css).toMatch(/\.discovery-settings__range input\s*\{[^}]*height: 44px;/);
    expect(css).toMatch(/\.discovery-settings__range input\s*\{[^}]*background-clip: content-box;/);
    expect(css).toMatch(/\.discovery-settings__toggle\s*\{[^}]*min-height: 44px;/);
    expect(css).toMatch(/\.discovery-settings__heading\s*\{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:/);
    const source = settingsSource;
    expect(source).toContain("import './discovery-settings.css'");
    expect(source).not.toMatch(/onPointerUp|onMouseUp|onTouchEnd/);
  });
});
