// @vitest-environment happy-dom
// ALLOWANCE-ARCH-001 (owner, 2026-11-20): "the allowance shouldn't apply on wifi, keep 100mb as default, full song
// download shouldn't get limited". Settings says what the allowance is now (a mobile data allowance for background
// work), what the connection is, how much is left, and when paused work resumes.
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsView } from './Settings';
import type { Settings } from './api';

const { fx } = vi.hoisted(() => ({
  fx: {
    allowance: { capacity: 100_000_000, level: 62_000_000, refill_per_hour: 4_166_667, unmetered: false, paused: false, resumes_at: null as number | null, today: { interactive: 1_400_000, playback: 1_200_000, background: 3_100_000 } as Record<string, number> },
    refreshed: null as null | { cleared_bytes: number; restored_bytes: number; day: string },
  },
}));
vi.mock('./api', () => ({
  api: {
    health: (refresh = false) => Promise.resolve({
      ok: true, providers: {}, checked_at: 0,
      audio: { installed: false, dim: 0, vectors: 0, license: 'AGPL-3.0', check: { state: 'ok', detail: null } },
      ...(refresh && fx.refreshed ? { allowance_refreshed: fx.refreshed } : {}),
    }),
    status: () => Promise.resolve({
      storage: { areas: { cache: 1, other: 1 }, queue_audio: null, app_data: 2, limits: { cache: 150_000_000 }, total: 2, hard_cap: 4e9, target: 4e9, free_disk: 3e9, not_counted: '' },
      allowance: fx.allowance,
      transfer_today: { metadata: 5_000_000, search: 700_000 }, transfer_daily_cap: 100_000_000, transfer_request_cap: 20_000_000, transfer_note: '',
      cache: { hits: 0, misses: 1, bytes: 1, vectors: 0 }, startup_ms: 10, memory: { rss: null, peak: null }, telemetry: 'none',
    }),
  },
}));
vi.mock('./MicSettings', () => ({ MicSettings: () => null }));
afterEach(() => { cleanup(); fx.allowance = { ...fx.allowance, level: 62_000_000, unmetered: false, paused: false, resumes_at: null }; fx.refreshed = null; });

const saved: Settings = { fresh: false, adventurous: 0.5, audio: true, daily_mb: 100, request_mb: 20, sample_mode: false };
const view = () => render(<SettingsView settings={saved} onSettings={vi.fn()} onReset={vi.fn()} onResetTaste={vi.fn()} />);
const now = () => screen.findByRole('status', { name: 'Mobile data allowance now' });

it('calls it a mobile data allowance, still 100 MB, and says what is never limited', async () => {
  const { container } = view();
  await now();
  expect(container.textContent).toContain('Mobile data allowance');
  expect(container.textContent).not.toContain('Daily download allowance');
  expect(container.textContent).toMatch(/Searching, playing and downloading songs are never limited/);
  const field = container.querySelector<HTMLInputElement>('input.field--num')!;
  expect(field.value).toBe('100');
});

it('on mobile data it says how much is left', async () => {
  view();
  expect((await now()).textContent).toMatch(/mobile data.*62 MB of 100 MB left/i);
});

it('off mobile data it says nothing is limited', async () => {
  fx.allowance = { ...fx.allowance, unmetered: true };
  view();
  const line = (await now()).textContent ?? '';
  expect(line).toMatch(/not metered/i);
  expect(line).toMatch(/nothing is limited/i);
  expect(line).not.toMatch(/left/);
});

it('paused, it says when finding new songs resumes by itself', async () => {
  fx.allowance = { ...fx.allowance, level: 0, paused: true, resumes_at: Date.now() / 1000 + 12 * 60 };
  view();
  expect((await now()).textContent).toMatch(/paused.*resumes by itself in about 12 min/i);
});

it('today\u2019s reading is listed by what it was for', async () => {
  view();
  const panel = await waitFor(() => screen.getByRole('region', { name: 'Storage and downloads' }));
  await now();
  expect(panel.textContent).toMatch(/you asked for\s*1\.4 MB/i);
  expect(panel.textContent).toMatch(/playing songs\s*1\.2 MB/i);
  expect(panel.textContent).toMatch(/in the background\s*3\.1 MB/i);
  expect(panel.textContent).not.toMatch(/5\.7 MB of 100 MB/);
});

it('"Check again" says what it gave back', async () => {
  fx.refreshed = { cleared_bytes: 5_700_000, restored_bytes: 38_000_000, day: '2026-11-20' };
  view();
  await now();
  fireEvent.click(screen.getByRole('button', { name: /check again/i }));
  await waitFor(() => expect(document.body.textContent).toMatch(/Allowance refreshed: 38 MB given back for finding new songs on mobile data/));
});

// Measured on the Windows app (2026-11-20): as a loose item of the two-column settings grid the status line landed in
// the 170 px label column (117 px tall) and pushed every later label and field into the wrong column.
it('the status line sits in the value cell beside its label, so the label/value grid keeps its pairs', async () => {
  const { container } = view();
  const line = await now();
  const cell = line.parentElement!;
  expect(cell.parentElement!.classList.contains('pref')).toBe(true);
  expect(cell.previousElementSibling?.textContent).toBe('Mobile data allowance');
  expect(cell.querySelector('input.field--num')).toBeTruthy();
  // Its own grid stays label, value, label, value... (other grids place their items themselves).
  void container;
  [...cell.parentElement!.children].forEach((k, i) => expect(k.classList.contains('k'), `child ${i}: ${k.textContent?.slice(0, 30)}`).toBe(i % 2 === 0));
});
