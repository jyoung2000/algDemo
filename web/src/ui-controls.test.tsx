// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import appSource from './App.tsx?raw';
import { SettingsView } from './Settings';

// Settings asks for live source health on mount; this suite is about the controls, not the network.
vi.mock('./api', () => ({ api: { health: () => new Promise(() => {}), status: () => new Promise(() => {}) } }));
vi.mock('./MicSettings', () => ({ MicSettings: () => null }));
afterEach(cleanup);

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'styles.css'), 'utf8');
/** The rule whose selector list STARTS with this selector, not one that merely contains it. */
const rule = (selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${esc}\\s*\\{[^}]*\\}`, 'm').exec(css);
  expect(m, `no CSS rule starting with ${selector}`).toBeTruthy();
  const body = m![0];
  expect(body.length, `empty rule for ${selector}`).toBeGreaterThan(selector.length + 3);
  return body;
};

/**
 * CLEAR-ICON-001 — the two list actions must look like one another.
 *
 * Owner: "have the clear list icon be in the same style as the download icon".
 *
 * The download action became an `.iconbtn` circle with a glyph; Clear list was still a
 * `.push push--small` pill with the word on it, so the pair read as two unrelated controls.
 */
describe('the list header actions', () => {
  const headers = appSource.split('className="queue__actions"').slice(1);

  it('wraps both actions in a group, in both list headers', () => {
    expect(headers.length).toBe(2);
  });

  it.each([0, 1])('renders Clear list as an icon button like the download one (header %i)', (i) => {
    const block = headers[i]!.slice(0, 900);
    expect(block).toContain('<ListDownloadButton');
    // Same control class as the download action, and no pill class left behind.
    expect(block).toMatch(/className="iconbtn"[\s\S]*?name="clear"/);
    expect(block).not.toMatch(/className="push push--small"[\s\S]*?Clear list/);
  });

  it.each([0, 1])('keeps the words off the button but available to a screen reader (header %i)', (i) => {
    const block = headers[i]!.slice(0, 900);
    expect(block).toMatch(/aria-label="[^"]*[Cc]lear[^"]*"/);
    expect(block).toMatch(/title="[^"]*"/); // still explains itself on hover
  });
});

/**
 * BTN-TEXT-001 — "ensure the text in the buttons are centered and justified".
 *
 * `.push` is used both as a `<button>` and as an `<a>` (Export my data). An anchor is not a button
 * box, so its label sat left while the real buttons looked centred.
 */
describe('button labels', () => {
  it('centres the label in every pill button', () => {
    const r = rule('.push');
    expect(r).toMatch(/text-align:\s*center/);
  });

  it('centres a pill that is laid out as a flex row of icon and words', () => {
    const r = rule('.push');
    expect(r).toMatch(/justify-content:\s*center/);
    expect(r).toMatch(/align-items:\s*center/);
  });
});

/**
 * RESET-APP-001 — "ensure the settings has a reset app icon that resets everything back to default".
 *
 * There was a reset, labelled "Reset…" with no icon, and it deliberately kept the cache — so it did
 * not put the app back to how it shipped.
 */
describe('reset the app', () => {
  const settingsProps = () => ({
    settings: null, onSettings: vi.fn(), onReset: vi.fn(), onResetTaste: vi.fn(), sources: {},
  });

  it('offers a reset carrying an icon, not just words', () => {
    const p = settingsProps();
    render(<SettingsView {...p} />);
    const btn = screen.getByRole('button', { name: /reset the app|reset everything|back to default/i });
    expect(btn.querySelector('svg')).toBeTruthy();
  });

  it('asks before wiping, then resets everything', async () => {
    const user = userEvent.setup();
    const p = settingsProps();
    render(<SettingsView {...p} />);
    await user.click(screen.getByRole('button', { name: /reset the app|reset everything|back to default/i }));
    expect(p.onReset).not.toHaveBeenCalled(); // a destructive action is never one click
    const confirm = screen.getByRole('button', { name: /^reset everything$/i });
    await user.click(confirm);
    expect(p.onReset).toHaveBeenCalledTimes(1);
  });

  it('promises the downloads go too, and that kept music does not', () => {
    render(<SettingsView {...settingsProps()} />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/default/i);
  });
});
