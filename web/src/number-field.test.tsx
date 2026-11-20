// @vitest-environment happy-dom
// CUSTOM-INPUTS-001 (owner, 2026-11-20): "ensure all the customize setting inputs work on all platforms". Measured on the
// Android phone: the number fields saved every keystroke, so deleting the last digit saved 0 → clamped to 5 → the field
// read "5", and typing 400 produced "540" then "2000". A field now keeps what is typed and saves only a whole valid number;
// leaving it empty or out of range puts back a valid value when focus leaves.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, useState } from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { NumberField } from './NumberField';
afterEach(cleanup);

/** A parent that clamps what it is given, as the engine's settings do. */
function Clamping({ onSave }: { onSave: (n: number) => void }) {
  const [v, setV] = useState(400);
  return createElement(NumberField, { 'aria-label': 'Daily', min: 5, max: 2000, step: 5, value: v, onValue: (n: number) => { const c = Math.min(2000, Math.max(5, n)); onSave(c); setV(c); } });
}

describe('NumberField', () => {
  it('can be cleared and retyped digit by digit: 400 → "" → 3 → 30 → 300 saves 300 (never 5, never 2000)', () => {
    const save = vi.fn();
    const { getByLabelText } = render(createElement(Clamping, { onSave: save }));
    const f = getByLabelText('Daily') as HTMLInputElement;
    f.focus();
    for (const v of ['40', '4', '']) { fireEvent.change(f, { target: { value: v } }); expect(f.value).toBe(v); }
    for (const v of ['3', '30', '300']) { fireEvent.change(f, { target: { value: v } }); expect(f.value).toBe(v); }
    fireEvent.blur(f);
    expect(f.value).toBe('300');
    expect(save).toHaveBeenLastCalledWith(300);
    expect(save.mock.calls.flat()).not.toContain(5);
    expect(save.mock.calls.flat()).not.toContain(2000);
  });
  it('left empty, the saved value comes back on blur; out of range is pulled into range on blur', () => {
    const save = vi.fn();
    const { getByLabelText } = render(createElement(Clamping, { onSave: save }));
    const f = getByLabelText('Daily') as HTMLInputElement;
    f.focus();
    fireEvent.change(f, { target: { value: '' } });
    fireEvent.blur(f);
    expect(f.value).toBe('400');
    f.focus();
    fireEvent.change(f, { target: { value: '9000' } });
    fireEvent.blur(f);
    expect(f.value).toBe('2000');
    expect(save).toHaveBeenLastCalledWith(2000);
  });
  it('a value changed elsewhere shows when the field is not being edited; uses the numeric keyboard', () => {
    const { getByLabelText, rerender } = render(createElement(NumberField, { 'aria-label': 'N', min: 1, max: 500, value: 10, onValue: () => undefined }));
    rerender(createElement(NumberField, { 'aria-label': 'N', min: 1, max: 500, value: 25, onValue: () => undefined }));
    const f = getByLabelText('N') as HTMLInputElement;
    expect(f.value).toBe('25');
    expect(f.getAttribute('inputmode')).toBe('numeric');
  });
  it('no number input in the app saves straight from each keystroke', () => {
    const dir = resolve(process.cwd(), 'src');
    const bad = readdirSync(dir).filter((n) => n.endsWith('.tsx') && !n.includes('.test.'))
      .filter((n) => /type="number"[\s\S]{0,400}?onChange=\{\(e\) => [^}]*Number\(e\.target\.value\)/.test(readFileSync(resolve(dir, n), 'utf8')));
    expect(bad).toEqual([]);
  });
});
