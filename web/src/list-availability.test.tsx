// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ListAvailability } from './ListAvailability';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { if (root) await act(() => root!.unmount()); document.body.innerHTML = ''; });
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
