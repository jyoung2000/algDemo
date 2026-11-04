// @vitest-environment happy-dom
// STORAGE-TRUTH-001 at the UI: the panel must show the audio the app really stores, against the
// same limit the owner sets in "Queue audio storage limit", and must not claim songs are not stored.
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { SettingsView } from './Settings';
import type { Settings } from './api';

const { statusFixture } = vi.hoisted(() => ({
  statusFixture: {
    storage: {
      areas: { cache: 709_000, other: 1_400_000 },
      queue_audio: { bytes: 69_600_218, limit: 1_073_741_824 },
      app_data: 2_109_000,
      limits: { cache: 150_000_000 },
      total: 71_709_218,
      hard_cap: 4_000_000_000,
      target: 4_000_000_000,
      free_disk: 3_000_000_000,
      not_counted: 'Songs you Download are copied to your music folder and are not counted here.',
    },
    transfer_today: { audio: 10_000_000, metadata: 61_000_000 },
    transfer_daily_cap: 100_000_000,
    transfer_request_cap: 20_000_000,
    transfer_note: 'Network the page itself read today.',
    cache: { hits: 0, misses: 1, bytes: 709_000, vectors: 0 },
    startup_ms: 10,
    memory: { rss: null, peak: null },
    telemetry: 'none',
  },
}));

vi.mock('./api', () => ({
  api: {
    health: () => Promise.resolve({
      ok: true, providers: {}, checked_at: 0,
      audio: { installed: false, dim: 0, vectors: 0, license: 'AGPL-3.0', check: { state: 'ok', detail: null } },
    }),
    status: () => Promise.resolve(statusFixture),
  },
}));
vi.mock('./MicSettings', () => ({ MicSettings: () => null }));
afterEach(cleanup);

const saved: Settings = { fresh: false, adventurous: 0.5, audio: true, daily_mb: 100, request_mb: 20, sample_mode: false };
const view = () => render(<SettingsView settings={saved} onSettings={vi.fn()} onReset={vi.fn()} onResetTaste={vi.fn()} />);

it('shows stored song audio against the queue audio limit, not just the WebView estimate', async () => {
  const { container } = view();
  const panel = await waitFor(() => screen.getByRole('region', { name: 'Storage and downloads' }));
  // 69,600,218 B of a 1 GiB limit — the figure the storage limit slider governs.
  expect(panel.textContent).toContain('70 MB of 1.07 GB');
  // and the WebView origin's own data is still reported, but labelled as app data, not as the total
  expect(panel.textContent).toContain('2.1 MB');
  expect(container.textContent).not.toMatch(/embedded player/i);
});

it('never claims the app uses only its origin data when songs are stored on disk', async () => {
  view();
  const panel = await waitFor(() => screen.getByRole('region', { name: 'Storage and downloads' }));
  // The old panel said "2.1 MB of 4 GB used by the app" while 70 MB of songs sat on disk.
  expect(panel.textContent).not.toContain('2.1 MB of 4 GB used by the app');
});
