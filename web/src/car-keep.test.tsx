// @vitest-environment happy-dom
// CAR-KEEP-001: the Settings "Android Auto" card: one wording per install verdict, nothing where the
// phone bridge is absent, a real button that asks the phone, and a message when the phone could not.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CarKeep, INSTALL_LINE, OPEN_FAILED, STEPS } from './CarKeep';

type NativeWindow = { AirwaveNative?: unknown };
const win = window as unknown as NativeWindow;

const reply = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    verdict: 'PLAY_NAME_ONLY',
    installer: 'com.android.vending',
    initiating: 'com.android.shell',
    originating: null,
    androidAuto: { installed: true, version: '17.9.664044-release' },
    sdk: 34,
    ...over,
  });

const mount = (over: Record<string, unknown> = {}, open: () => unknown = () => true) => {
  const openCarSettings = vi.fn(open);
  win.AirwaveNative = { carInstall: () => reply(over), openCarSettings };
  return { openCarSettings, ...render(<CarKeep />) };
};

afterEach(() => {
  cleanup();
  delete win.AirwaveNative;
});

describe('where the phone bridge is absent', () => {
  it('renders nothing with no bridge (browser)', () => {
    const { container } = render(<CarKeep />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the bridge has no carInstall (Windows, older APKs)', () => {
    win.AirwaveNative = { version: () => '0.20.13', openCarSettings: () => true };
    const { container } = render(<CarKeep />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the phone answers with something unreadable', () => {
    win.AirwaveNative = { carInstall: () => '{nope' };
    const { container } = render(<CarKeep />);
    expect(container.innerHTML).toBe('');
  });
});

describe('how jPlay was installed', () => {
  it('has the heading Android Auto, naming the card', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Android Auto' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Android Auto' })).toBeTruthy();
  });

  it('installed by adb in Google Play\u2019s name: says so and warns it may be hidden again', () => {
    mount({ verdict: 'PLAY_NAME_ONLY' });
    const line = screen.getByText(INSTALL_LINE.PLAY_NAME_ONLY);
    expect(line.textContent).toContain("installed from a computer in Google Play's name");
    expect(line.textContent).toContain('Android Auto may hide it again once it checks with Google Play');
    expect(screen.getByText(/To keep jPlay in the car without a computer/)).toBeTruthy();
  });

  it('really installed by Google Play: says Android Auto keeps it', () => {
    mount({ verdict: 'PLAY', initiating: 'com.android.vending' });
    const line = screen.getByText(INSTALL_LINE.PLAY);
    expect(line.textContent).toContain('Google Play installed jPlay');
    expect(line.textContent).toContain('Android Auto keeps');
    expect(screen.getByText(/If jPlay ever goes missing from the car/)).toBeTruthy();
  });

  it('installed directly: says Android Auto hides it unless Unknown sources is on', () => {
    mount({ verdict: 'SIDELOADED', installer: null });
    const line = screen.getByText(INSTALL_LINE.SIDELOADED);
    expect(line.textContent).toContain('not by Google Play');
    expect(line.textContent).toContain('"Unknown sources"');
  });

  it('the three wordings differ', () => {
    expect(new Set(Object.values(INSTALL_LINE)).size).toBe(3);
  });
});

describe('the steps and the small print', () => {
  it('lists the Unknown sources and Customize launcher steps in order', () => {
    mount();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([...STEPS]);
    expect(items).toEqual([
      'Open Android Auto settings and scroll to the bottom.',
      'Tap "Version" ten times, then accept developer mode.',
      'Open the three-dot menu and choose "Developer settings".',
      'Turn on "Unknown sources".',
      'Open "Customize launcher" and make sure jPlay is ticked.',
      'Reconnect the car.',
    ]);
    expect(document.querySelector('ol.carkeep__steps')).toBeTruthy();
  });

  it('says jPlay cannot read or change the switch, and names the Google Play testing route once', () => {
    mount();
    expect(screen.getByText(/jPlay cannot read or change that switch itself/)).toBeTruthy();
    expect(screen.getAllByText(/Google Play internal testing track/)).toHaveLength(1);
  });

  it('shows the Android Auto version the phone has', () => {
    mount();
    expect(screen.getByText('Android Auto on this phone: version 17.9.664044-release.')).toBeTruthy();
  });

  it('says so when Android Auto is not installed, and keeps the steps and the button', () => {
    mount({ androidAuto: { installed: false, version: null } });
    expect(screen.getByText(/Android Auto is not installed on this phone/)).toBeTruthy();
    expect(screen.queryByText(/Android Auto on this phone: version/)).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(STEPS.length);
    expect(screen.getByRole('button', { name: 'Open Android Auto settings' })).toBeTruthy();
  });

  it('does not mention a missing Android Auto when it is installed', () => {
    mount();
    expect(screen.queryByText(/Android Auto is not installed/)).toBeNull();
  });
});

describe('Open Android Auto settings', () => {
  it('is a real button that asks the phone, with no message when it opened', () => {
    const { openCarSettings } = mount();
    const button = screen.getByRole('button', { name: 'Open Android Auto settings' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(openCarSettings).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(openCarSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says what to do instead when the phone could not open it, and clears that once it does', () => {
    let ok = false;
    mount({}, () => ok);
    const button = screen.getByRole('button', { name: 'Open Android Auto settings' });
    fireEvent.click(button);
    expect(screen.getByRole('alert').textContent).toBe(OPEN_FAILED);
    ok = true;
    fireEvent.click(button);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the message, not an error, when the bridge has no openCarSettings or it throws', () => {
    win.AirwaveNative = { carInstall: () => reply() };
    render(<CarKeep />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Android Auto settings' }));
    expect(screen.getByRole('alert').textContent).toBe(OPEN_FAILED);
    cleanup();
    mount({}, () => {
      throw new Error('bridge gone');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Android Auto settings' }));
    expect(screen.getByRole('alert').textContent).toBe(OPEN_FAILED);
  });
});

describe('car-keep.css', () => {
  const css = readFileSync(`${process.cwd()}/src/car-keep.css`, 'utf8').replace(/\r/g, '');

  it('gives the button a 44px touch height and lets it wrap instead of overflowing', () => {
    const rule = /\.carkeep \.carkeep__open\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/min-height:\s*44px/);
    expect(rule).toMatch(/max-width:\s*100%/);
    expect(rule).toMatch(/white-space:\s*normal/);
  });

  it('takes every colour from the app\u2019s variables and sets no fixed width', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(css).not.toMatch(/(^|[\s;{])(min-)?width:\s*\d+px/);
    for (const v of css.match(/var\(--[a-z0-9-]+\)/g) ?? []) expect(['var(--ink)', 'var(--ink-2)', 'var(--danger)']).toContain(v);
  });
});
