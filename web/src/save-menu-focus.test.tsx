// @vitest-environment happy-dom
// CUSTOM-INPUTS-001 (owner, 2026-11-20): inputs must keep focus on every platform. The save menu re-ran its focus effect
// whenever the page passed a new onClose (every redraw while a song plays), pulling focus out of the list-name field.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
vi.mock('./api', () => ({ api: { playlistEdit: vi.fn() } }));
import { SaveMenu } from './SaveMenu';
afterEach(cleanup);

const lists = [{ id: 'l1', name: 'Mine', items: [], created: 0, updated: 0 }] as never;
const props = () => ({ songKey: 'k', title: 'Song', lists, onLists: vi.fn(), onClose: vi.fn() });

describe('save menu', () => {
  it('typing a new list name keeps the field focused through redraws (new onClose each time)', () => {
    const { container, rerender } = render(createElement(SaveMenu, props()));
    const create = [...container.querySelectorAll('button')].find((b) => /new list/i.test(b.textContent ?? ''));
    if (create) fireEvent.click(create);
    const field = container.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!;
    expect(field).toBeTruthy();
    field.focus();
    fireEvent.change(field, { target: { value: 'Road trip' } });
    for (let i = 0; i < 3; i++) rerender(createElement(SaveMenu, props()));
    expect(document.activeElement).toBe(field);
  });
  it('Escape still closes with the latest onClose', () => {
    const p1 = props(), p2 = props();
    const { rerender } = render(createElement(SaveMenu, p1));
    rerender(createElement(SaveMenu, p2));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(p2.onClose).toHaveBeenCalledTimes(1);
    expect(p1.onClose).not.toHaveBeenCalled();
  });
});
