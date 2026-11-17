import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * BTN-UNIFORM-001 — owner: "on the android and windows app can we ensure all buttons have consistent ui and ux".
 *
 * Both shells run this one bundle, so the contract is checked on the source: every button family reacts to a
 * press and to the pointer, hover styling cannot stick after a tap on a phone, and one sheet (loaded last)
 * carries the shared rules. How the buttons actually paint is measured on the two apps, not here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, name), 'utf8').replace(/\r\n/g, '\n');
const kit = readFileSync(join(here, '../../../packages/aqua-ui/src/styles/airwave-window.css'), 'utf8').replace(/\r\n/g, '\n');
const sheets = readdirSync(here).filter((f) => f.endsWith('.css'));
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every style rule with the @media it sits in. */
function rules(css: string): { media: string; selector: string; body: string }[] {
  const out: { media: string; selector: string; body: string }[] = [];
  const stack: string[] = [];
  const text = strip(css);
  const re = /([^{}]+)\{|\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // Group 1 is missing only for the bare `}` branch.
    if (m[0] === '}' || m[1] === undefined) { stack.pop(); continue; }
    const selector = m[1].trim();
    if (selector.startsWith('@')) { stack.push(selector); continue; }
    out.push({ media: stack.filter((s) => s.startsWith('@media')).join(' '), selector, body: text.slice(re.lastIndex, text.indexOf('}', re.lastIndex)) });
    stack.push('rule');
  }
  return out;
}

const app = sheets.flatMap((f) => rules(read(f)).map((r) => ({ ...r, file: f })));
const everything = [...app, ...rules(kit).map((r) => ({ ...r, file: 'kit' }))];
const contract = () => read('button-contract.css');

/** The class names each <button>/<summary> in the app is written with. */
function buttonFamilies(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of readdirSync(here).filter((n) => n.endsWith('.tsx') && !n.includes('.test.'))) {
    const src = read(f);
    for (const m of src.matchAll(/<(button|summary)\b((?:[^>{]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*)>/g)) {
      // Group 2 always takes part (it may be empty); one of the two className groups always matches.
      const cls = /className=(?:"([^"]*)"|\{((?:[^{}]|\{[^{}]*\})*)\})/.exec(m[2] ?? '');
      const raw = !cls ? '' : cls[1] ?? [...(cls[2] ?? '').matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((q) => q[1] ?? q[2] ?? q[3]).join(' ');
      const names = raw.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter((n) => /^[a-z][\w-]*$/.test(n) && !/^is-/.test(n));
      const line = src.slice(0, m.index).split('\n').length;
      found.set(`${f}:${line}`, names);
    }
  }
  return found;
}

describe('one button contract for both shells (BTN-UNIFORM-001)', () => {
  it('loads the contract after every other sheet', () => {
    const main = read('main.tsx');
    const imports = [...main.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports.at(-1)).toBe("import './button-contract.css';");
  });

  it('never lets hover styling stick to a tapped button on a phone', () => {
    const loose = app.filter((r) => r.selector.includes(':hover') && !/hover:\s*hover/.test(r.media) && !/slider-thumb|range-thumb/.test(r.selector));
    expect(loose.map((r) => `${r.file}: ${r.selector.replace(/\s+/g, ' ')}`)).toEqual([]);
  });

  it('switches the WebView tap flash off for everything and sets the hand, press and focus for every button', () => {
    const css = contract();
    expect(css).toMatch(/html \{[^}]*-webkit-tap-highlight-color: transparent;/);
    expect(css).toMatch(/:where\(button, \[role='button'\], \[role='tab'\], summary, a\.push, a\.openlink\) \{[^}]*cursor: pointer;[^}]*touch-action: manipulation;/);
    expect(css).toMatch(/:root button:disabled \{[^}]*cursor: default;/);
    expect(css).toMatch(/:active:where\(:not\(:disabled\)\) \{[^}]*transform: scale\(var\(--btn-press-scale\)\);/);
    expect(css).toMatch(/:focus-visible \{[^}]*outline: 2px solid var\(--focus\);/);
    expect(css).toMatch(/@media \(pointer: coarse\) \{[^}]*min-height: var\(--btn-touch\);/);
    expect(css).toMatch(/--btn-touch: 44px;/);
  });

  it('gives every button family a pressed look', () => {
    const css = contract();
    const optedOut = /:where\(\s*:is\(button[^)]*\):not\(([^)]*)\)/.exec(css)?.[1]?.split(',').map((s) => s.trim().replace(/^\./, '')) ?? [];
    expect(optedOut.length).toBeGreaterThan(0);
    const pressed = (name: string) => everything.some((r) => new RegExp(`\\.${name}(?![\\w-])[^,{]*:active`).test(r.selector));
    // A family the shared press skips (a full-width row, a text link) must bring its own.
    expect(optedOut.filter((name) => !pressed(name))).toEqual([]);
  });

  it('gives every button family a pointer-over look on Windows', () => {
    const hovers = (name: string) => everything.some((r) => new RegExp(`\\.${name}(?![\\w-])[^,{]*:hover`).test(r.selector));
    const bare = /(?:^|,)\s*(?:\.[\w-]+ )*(?:button|summary)[^,{]*:hover/;
    const missing: string[] = [];
    for (const [where, names] of buttonFamilies()) {
      if (names.length ? names.some(hovers) : app.some((r) => bare.test(r.selector))) continue;
      missing.push(`${where} ${names.join('.') || '(no class)'}`);
    }
    expect(missing).toEqual([]);
  });

  it('dims every switched-off button the same way', () => {
    expect(contract()).toMatch(/:root button:disabled:not\(\.linkbtn\) \{[^}]*opacity: var\(--btn-off-opacity\);/);
  });
});
