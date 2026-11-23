// CAR-KEEP-001: the typed reader for AirwaveNative.carInstall() / openCarSettings().
import { afterEach, describe, expect, it, vi } from 'vitest';
import { carInstall, openCarSettings } from './car-install';

type G = { window?: { AirwaveNative?: unknown } };
const g = globalThis as unknown as G;
const hadWindow = 'window' in globalThis;
const bridge = (b: unknown): void => {
  g.window = { ...(g.window ?? {}), AirwaveNative: b };
};

afterEach(() => {
  if (hadWindow) delete g.window?.AirwaveNative;
  else delete g.window;
});

const full = {
  verdict: 'PLAY_NAME_ONLY',
  installer: 'com.android.vending',
  initiating: 'com.android.shell',
  originating: null,
  androidAuto: { installed: true, version: '17.9.664044-release' },
  sdk: 34,
};

describe('carInstall', () => {
  it('is null with no window, no bridge, or a bridge without the method (Windows, browser, old APKs)', () => {
    expect(carInstall()).toBeNull();
    bridge(undefined);
    expect(carInstall()).toBeNull();
    bridge({ version: () => '0.20.13', downloads: () => '' });
    expect(carInstall()).toBeNull();
  });

  it('reads what the phone reports', () => {
    bridge({ carInstall: () => JSON.stringify(full) });
    expect(carInstall()).toEqual(full);
  });

  it('calls the method on the bridge object, as an Android bridge requires', () => {
    const b = {
      carInstall(this: unknown): string {
        if (this !== b) throw new Error('detached');
        return JSON.stringify(full);
      },
    };
    bridge(b);
    expect(carInstall()?.verdict).toBe('PLAY_NAME_ONLY');
  });

  it.each(['PLAY', 'PLAY_NAME_ONLY', 'SIDELOADED'])('accepts the verdict %s', (verdict) => {
    bridge({ carInstall: () => JSON.stringify({ ...full, verdict }) });
    expect(carInstall()?.verdict).toBe(verdict);
  });

  it('fills in what a reply leaves out, and never reports a version for a missing Android Auto', () => {
    bridge({ carInstall: () => JSON.stringify({ verdict: 'SIDELOADED', installer: '', androidAuto: { installed: false, version: '9.9' } }) });
    expect(carInstall()).toEqual({
      verdict: 'SIDELOADED',
      installer: null,
      initiating: null,
      originating: null,
      androidAuto: { installed: false, version: null },
      sdk: 0,
    });
    bridge({ carInstall: () => JSON.stringify({ verdict: 'PLAY' }) });
    expect(carInstall()?.androidAuto).toEqual({ installed: false, version: null });
  });

  it.each([
    ['not JSON', '{verdict'],
    ['an empty string', ''],
    ['JSON null', 'null'],
    ['a JSON number', '7'],
    ['an unknown verdict', JSON.stringify({ ...full, verdict: 'MAYBE' })],
    ['no verdict', JSON.stringify({ installer: 'com.android.vending' })],
  ])('is null for %s', (_name, reply) => {
    bridge({ carInstall: () => reply });
    expect(carInstall()).toBeNull();
  });

  it('is null when the bridge answers with a non-string or throws', () => {
    bridge({ carInstall: () => undefined });
    expect(carInstall()).toBeNull();
    bridge({
      carInstall: () => {
        throw new Error('bridge gone');
      },
    });
    expect(carInstall()).toBeNull();
  });
});

describe('openCarSettings', () => {
  it('is false when the bridge or the method is absent', () => {
    expect(openCarSettings()).toBe(false);
    bridge({ carInstall: () => JSON.stringify(full) });
    expect(openCarSettings()).toBe(false);
  });

  it('passes on what the phone answered, and only a real true counts', () => {
    const open = vi.fn(() => true as unknown);
    bridge({ openCarSettings: open });
    expect(openCarSettings()).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    open.mockReturnValue(false);
    expect(openCarSettings()).toBe(false);
    open.mockReturnValue('true');
    expect(openCarSettings()).toBe(false);
  });

  it('is false, not an exception, when the bridge throws', () => {
    bridge({
      openCarSettings: () => {
        throw new Error('bridge gone');
      },
    });
    expect(openCarSettings()).toBe(false);
  });
});
