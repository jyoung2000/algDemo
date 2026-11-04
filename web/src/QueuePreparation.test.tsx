// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueuePreparation } from './QueuePreparation';
import type { Track } from './api';
const rig = vi.hoisted(() => ({ states: new Map<string, string>(), started: [] as string[], changed: () => {} }));
vi.mock('./engine/downloads', () => ({ downloadsAvailable: () => true }));
vi.mock('./engine/queue-audio', async () => {
  const { QueuePreloader } = await import('./engine/queue-preload');
  return { queueAudio: new QueuePreloader({
    configure: async () => undefined,
    resolve: async t => t.key,
    library: {
      subscribe: f => { rig.changed = f; return () => {}; },
      status: u => rig.states.get(u) ?? 'unknown', error: () => null,
      ensure: async u => { rig.started.push(u); rig.states.set(u, 'running'); },
    },
  }) };
});
afterEach(() => { cleanup(); rig.states.clear(); rig.started.length = 0; });
it('starts without pressing Play, reaches far rows, and displays actual readiness', async () => {
  const tracks = Array.from({ length: 8 }, (_, i) => ({ key: `s${i}`, title: `Song ${i}`, artist: 'Test' }) as Track);
  render(<QueuePreparation tracks={tracks} />);
  await waitFor(() => expect(rig.started).toHaveLength(2));
  expect(screen.getByRole('status').textContent).toContain('0 of 8 songs ready locally');
  for (const t of tracks) {
    await waitFor(() => expect(rig.started).toContain(t.key));
    act(() => { rig.states.set(t.key, 'ready'); rig.changed(); });
  }
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('8 of 8 songs ready locally'));
  expect(new Set(rig.started).size).toBe(8);
});
