import { expect, it, vi } from 'vitest';
import { savedTracks, playbackRows, preparationTracks } from './queue-context';
import { stepQueue } from '../util';
import type { Track, SavedItem, PlaylistSummary } from '../api';
vi.mock('./downloads', () => ({ downloadsAvailable: () => true }));
const a = { key: 'a', title: 'A', artist: 'X', provider: 'deezer', platform_id: '1' } as Track;
const b = { ...a, key: 'b', title: 'B' };
const c = { ...a, key: 'c', title: 'C' };
const saved = [{ track: a }, { track: b }] as SavedItem[];
const lists = [{ id: 'p', items: [{ key: 'c', track: c }, { key: 'a', track: a }] }] as PlaylistSummary[];
it('uses saved playlist order (including engine-only tracks), never discovery order', () => {
  expect(savedTracks(saved, lists, 'p').map(t => t.key)).toEqual(['c', 'a']);
  expect(savedTracks(saved, lists, 'all').map(t => t.key)).toEqual(['a', 'b']);
});
it('next/previous includes every locally playable song without previews', () => {
  const rows = playbackRows([a,b,c]);
  const options = { shuffle: false, repeat: 'off' as const, heard: new Set<string>() };
  expect(stepQueue(rows, 'a', 1, new Set(), options)?.item.track.key).toBe('b');
  expect(stepQueue(rows, 'c', -1, new Set(), options)?.item.track.key).toBe('b');
});
it('prepares all lists without a four-row cap, prioritising selected and upcoming songs', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...a, key: `n${i}` }));
  const got = preparationTracks(b, [c], [...many, a, b], [a,c]);
  expect(got.slice(0,2).map(t=>t.key)).toEqual(['b','c']);
  expect(got).toHaveLength(33);
  expect(new Set(got.map(t=>t.key)).size).toBe(got.length);
});
