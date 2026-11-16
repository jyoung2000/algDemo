// @vitest-environment happy-dom
/**
 * Owner report (2026-11-15): "tapping on the artist name in the player does not bring up the artist
 * page". On a phone the player is the docked strip, which rendered the artist as plain text.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Player, type Playing } from './Player';
import { resetEngineForTests } from './audio-engine';

vi.mock('./engine/downloads', async (orig) => ({ ...(await orig<typeof import('./engine/downloads')>()), downloadsAvailable: () => false, playbackActive: () => undefined }));
vi.mock('./engine/queue-audio', () => ({ queueAudio: { readyUrl: () => null, sourceHint: () => null, protect: async () => undefined, subscribe: () => () => {} } }));
vi.mock('./api', () => ({ api: { previewUrl: () => new Promise(() => {}), fullSong: () => new Promise(() => {}) } }));

const node = () => {
  const p: Record<string, unknown> = { value: 1 };
  for (const k of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setValueCurveAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime']) p[k] = () => p;
  return { connect: (d: unknown) => d, disconnect: () => {}, gain: p, frequency: p, Q: p, threshold: p, knee: p, ratio: p, attack: p, release: p, detune: p, type: 'peaking' };
};
class FakeContext {
  state = 'running'; currentTime = 0; destination = node();
  resume = async () => {}; createGain = () => node(); createBiquadFilter = () => node(); createDynamicsCompressor = () => node();
  createAnalyser = () => ({ ...node(), fftSize: 2048, frequencyBinCount: 1024 }); createMediaElementSource = () => node();
}
const props = {
  upNext: [], canPrev: true, canNext: true, shuffle: false, repeat: 'off' as const,
  actions: { flags: {}, downloadState: 'idle' as const, downloadAvailable: false, onFeedback: vi.fn(), onDownload: vi.fn(), onDownloads: vi.fn() },
  onShuffle: vi.fn(), onRepeat: vi.fn(), onPrev: vi.fn(), onNext: vi.fn(), onListen: vi.fn(),
  onWheel: vi.fn(), onSelect: vi.fn(), onMenu: vi.fn(), onPickUpNext: vi.fn(),
};
const playing: Playing = {
  track: { key: 'k1', title: 'Singapore', artist: 'Ken Carson, Destroy Lonely', artists: ['Ken Carson', 'Destroy Lonely'], artist_ids: { deezer: '2568121' }, provider: 'deezer', platform_id: '1', duration: 180 } as unknown as Playing['track'],
  playback: { open: [], preview: null, embed: null } as unknown as Playing['playback'],
};
beforeEach(() => {
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // no network in a unit test
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  resetEngineForTests();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

for (const docked of [true, false]) {
  it(`opens each credited artist from the ${docked ? 'docked phone' : 'full-size'} player`, () => {
    const open = vi.fn();
    render(createElement(Player, { ...props, docked, playing, onOpenArtist: open }));
    fireEvent.click(screen.getByRole('button', { name: 'Open the artist Ken Carson' }));
    expect(open).toHaveBeenCalledWith({ id: 'dz:2568121', name: 'Ken Carson' });
    fireEvent.click(screen.getByRole('button', { name: 'Open the artist Destroy Lonely' }));
    expect(open).toHaveBeenLastCalledWith({ name: 'Destroy Lonely' });
  });
}
