// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ListAvailability } from './ListAvailability';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { if (root) await act(() => root!.unmount()); document.body.innerHTML = ''; });
it('explains automatic background retries instead of requiring Download all', async () => {
  const el = document.createElement('div'); document.body.append(el); root = createRoot(el);
  await act(() => root!.render(<ListAvailability total={4} ready={2} active={false} failed={2} blocked={false} onDownload={vi.fn()} />));
  expect(el.querySelector('.list-availability__help')?.textContent).toContain('automatically');
  expect(el.querySelector('.list-availability__help')?.textContent).not.toContain('Download all retries missing songs');
});

/**
 * LIST-METER-002, from the owner looking at 91 of 97 on a phone:
 *  - the unavailable-songs warning belongs in Settings, not on this card;
 *  - "the load visualizer shouldn't be at max width if all songs aren't loaded" - at 94% the bar
 *    was indistinguishable from done, so an incomplete list must always leave a visible gap;
 *  - "there should be animation showing songs being loaded and unloaded, like a spinning arrow".
 */
it('never fills the whole track while songs are still missing', async () => {
  const el = document.createElement('div'); document.body.append(el); root = createRoot(el);
  const fill = () => {
    const m = el.querySelector('.list-availability__meter') as HTMLElement | null;
    return parseFloat((m?.style.getPropertyValue('--available') ?? '0').replace('%', ''));
  };
  // 91 of 97 is 93.8% - visually full, but six songs are missing.
  await act(() => root!.render(<ListAvailability total={97} ready={91} active={false} failed={6} blocked={false} onDownload={vi.fn()} />));
  expect(fill()).toBeLessThanOrEqual(92);
  expect(fill()).toBeGreaterThan(50); // still proportional, not a fixed stub
  // One song short of done must STILL leave a gap.
  await act(() => root!.render(<ListAvailability total={97} ready={96} active={false} failed={1} blocked={false} onDownload={vi.fn()} />));
  expect(fill()).toBeLessThanOrEqual(92);
  // Only a genuinely complete list reaches the end.
  await act(() => root!.render(<ListAvailability total={97} ready={97} active={false} failed={0} blocked={false} onDownload={vi.fn()} />));
  expect(fill()).toBe(100);
});

it('keeps the fill proportional, so more ready songs still means a longer bar', async () => {
  const el = document.createElement('div'); document.body.append(el); root = createRoot(el);
  const fill = async (ready: number) => {
    await act(() => root!.render(<ListAvailability total={100} ready={ready} active={false} failed={0} blocked={false} onDownload={vi.fn()} />));
    const m = el.querySelector('.list-availability__meter') as HTMLElement;
    return parseFloat(m.style.getPropertyValue('--available').replace('%', ''));
  };
  const a = await fill(10), b = await fill(50), c = await fill(90);
  expect(a).toBeLessThan(b);
  expect(b).toBeLessThan(c);
});

it('spins while songs are loading and while they are being unloaded, and rests when settled', async () => {
  const el = document.createElement('div'); document.body.append(el); root = createRoot(el);
  const spinner = () => el.querySelector('.list-availability__spin');
  const render = (ready: number, active: boolean) =>
    act(() => root!.render(<ListAvailability total={10} ready={ready} active={active} failed={0} blocked={false} onDownload={vi.fn()} />));
  await render(3, true);
  expect(spinner()).not.toBeNull();
  expect(spinner()!.getAttribute('data-dir')).toBe('load');
  // Settled: everything local, nothing in flight.
  await render(10, false);
  expect(spinner()).toBeNull();
  // The shell evicted some: ready fell, which is the unload direction.
  await render(7, false);
  expect(spinner()).not.toBeNull();
  expect(spinner()!.getAttribute('data-dir')).toBe('unload');
});

it('the spinner is decorative, so it is never read out as content', async () => {
  const el = document.createElement('div'); document.body.append(el); root = createRoot(el);
  await act(() => root!.render(<ListAvailability total={10} ready={1} active={true} failed={0} blocked={false} onDownload={vi.fn()} />));
  expect(el.querySelector('.list-availability__spin')!.getAttribute('aria-hidden')).toBe('true');
});

it('does not carry the unavailable-songs warning; Settings owns it', async () => {
  const el = document.createElement('div'); document.body.append(el); root = createRoot(el);
  await act(() => root!.render(<ListAvailability total={97} ready={91} active={false} failed={6} blocked={false} onDownload={vi.fn()} />));
  const help = el.querySelector('.list-availability__help')?.textContent ?? '';
  expect(help).not.toMatch(/unavailable/i);
  expect(help).not.toMatch(/6 songs/);
});

it('renders current availability, grows on completion and shrinks on eviction; button requests missing music', async () => {
  const el = document.createElement('div'); document.body.append(el); root = createRoot(el);
  const download = vi.fn();
  const render = async (ready: number) => act(() => root!.render(<ListAvailability total={4} ready={ready} active={false} failed={0} blocked={false} onDownload={download} />));
  await render(1);
  expect(el.querySelector('[role=meter]')?.getAttribute('aria-valuenow')).toBe('1');
  expect(el.textContent).toContain('1 of 4 songs ready locally');
  await act(() => el.querySelector('button')!.click()); expect(download).toHaveBeenCalledTimes(1);
  await render(4);
  expect(el.querySelector('[role=meter]')?.getAttribute('aria-valuenow')).toBe('4');
  expect(el.querySelector('button')!.disabled).toBe(true);
  await render(2);
  expect(el.querySelector('[role=meter]')?.getAttribute('aria-valuenow')).toBe('2');
  expect(el.querySelector('button')!.disabled).toBe(false);
});
