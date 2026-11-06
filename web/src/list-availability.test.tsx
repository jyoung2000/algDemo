// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ListAvailability } from './ListAvailability';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read the stylesheet from disk rather than importing it: a `?raw` CSS import comes back empty
// under the happy-dom environment, which made the outline assertion pass against an empty string.
const availabilityCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'list-availability.css'), 'utf8');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { if (root) await act(() => root!.unmount()); document.body.innerHTML = ''; });

/**
 * LIST-METER-003, from the owner: "get rid of the black outline around the bar and move the download
 * all button next to the clear list and make the download all button just a download icon like the
 * download button". The card becomes a plain meter plus its caption; the action moves to the list
 * header where Clear list already lives, as an icon button matching every other row action.
 */
it('draws the meter with no outline around it', () => {
  const meterRule = availabilityCss.match(/\.list-availability__meter\s*\{[^}]*\}/)?.[0] ?? '';
  expect(meterRule, 'meter rule not found').not.toBe('');
  expect(meterRule).not.toMatch(/border\s*:/);
  expect(meterRule).not.toMatch(/outline\s*:/);
  // The track still has to be visible as a track.
  expect(meterRule).toMatch(/background/);
});

it('no longer puts a Download all button on the card', async () => {
  const el = document.createElement('div'); document.body.append(el); root = createRoot(el);
  await act(() => root!.render(<ListAvailability total={97} ready={91} active={false} failed={6} blocked={false} onDownload={vi.fn()} />));
  expect(el.querySelector('button')).toBeNull();
  expect(el.textContent).not.toMatch(/Download all/i);
  // The information it carried is still there.
  expect(el.textContent).toContain('91 of 97 songs ready locally');
  expect(el.querySelector('[role=meter]')).not.toBeNull();
});

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

// The action lives in the list header now (see list-download-button.test.tsx); this covers the meter
// tracking availability in both directions.
it('renders current availability, grows on completion and shrinks on eviction', async () => {
  const el = document.createElement('div'); document.body.append(el); root = createRoot(el);
  const render = async (ready: number) => act(() => root!.render(<ListAvailability total={4} ready={ready} active={false} failed={0} blocked={false} />));
  await render(1);
  expect(el.querySelector('[role=meter]')?.getAttribute('aria-valuenow')).toBe('1');
  expect(el.textContent).toContain('1 of 4 songs ready locally');
  await render(4);
  expect(el.querySelector('[role=meter]')?.getAttribute('aria-valuenow')).toBe('4');
  // A complete list is the only state that fills the track.
  expect(parseFloat((el.querySelector('.list-availability__meter') as HTMLElement).style.getPropertyValue('--available'))).toBe(100);
  await render(2);
  expect(el.querySelector('[role=meter]')?.getAttribute('aria-valuenow')).toBe('2');
  expect(parseFloat((el.querySelector('.list-availability__meter') as HTMLElement).style.getPropertyValue('--available'))).toBeLessThanOrEqual(92);
});

/**
 * SPIN-TRUTH-001 — the arrow turns only while the app is really resolving or downloading.
 *
 * The owner, watching a list that never finished: the arrow spun for songs that were only sitting
 * in backoff, or that nothing was being done about at all, so a stuck list looked busy for ever.
 * Waiting to retry is waiting, not work: the words say a retry is booked, the animation does not.
 */
const show = async (props: Partial<Parameters<typeof ListAvailability>[0]> = {}) => {
  const el = document.createElement('div'); document.body.append(el); root = createRoot(el);
  await act(() => root!.render(
    <ListAvailability total={97} ready={91} active={false} failed={6} blocked={false} retrying={6} {...props} />,
  ));
  return el;
};

it('spins while a download is actually running', async () => {
  const el = await show({ active: true });
  const spin = el.querySelector('.list-availability__spin');
  expect(spin, 'no spinner while a download is running').not.toBeNull();
  expect(spin?.getAttribute('data-dir')).toBe('load');
  expect(el.querySelector('.list-availability')?.getAttribute('data-state')).toBe('loading');
});

it('rests while songs are only waiting for a booked retry, with nothing downloading', async () => {
  const el = await show();
  expect(el.querySelector('.list-availability__spin'), 'spinning on backoff alone').toBeNull();
  expect(el.querySelector('.list-availability')?.getAttribute('data-state')).not.toBe('loading');
});

it('still says a retry is booked, and how many, in words', async () => {
  const el = await show();
  expect(el.textContent).toMatch(/retrying 6 songs/i);
});

it('rests when the list is complete and nothing is scheduled', async () => {
  const el = await show({ total: 5, ready: 5, failed: 0, retrying: 0 });
  expect(el.querySelector('.list-availability__spin')).toBeNull();
});

it('does not spin for a failure nothing is being done about', async () => {
  const el = await show({ total: 5, ready: 2, failed: 3, retrying: 0 });
  expect(el.querySelector('.list-availability__spin')).toBeNull();
});

it('does not spin when songs are parked for want of space, which is not a retry', async () => {
  const el = await show({ total: 5, ready: 2, failed: 3, blocked: true, retrying: 0 });
  expect(el.querySelector('.list-availability__spin')).toBeNull();
});
