import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * FLAT-BTN-001 — owner: "the find my next favorite and stop button arent uniform with the rest of the
 * redesign ... replace and remove all the striped ipod style buttons".
 *
 * The app was redesigned flat (the play disc, the quiet controls, the sliders) but its text buttons,
 * checkboxes and segments were still the window kit's Aqua drawings: glossy, pinstriped pills. They are
 * now flat faces in flat-controls.css and the drawings are never installed. This supersedes the part of
 * BTN-UNIFORM-001 that let the push family keep its drawing. How they paint is measured on the two apps.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, name), 'utf8').replace(/\r\n/g, '\n');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const sheets = readdirSync(here).filter((f) => f.endsWith('.css'));
const sources = readdirSync(here).filter((f) => f.endsWith('.tsx') && !f.includes('.test.'));

/** Every style rule with the @media it sits in. */
function rules(css: string): { media: string; selector: string; body: string }[] {
  const out: { media: string; selector: string; body: string }[] = [];
  const stack: string[] = [];
  const text = strip(css);
  const re = /([^{}]+)\{|\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0] === '}' || m[1] === undefined) { stack.pop(); continue; }
    const selector = m[1].trim();
    if (selector.startsWith('@')) { stack.push(selector); continue; }
    out.push({ media: stack.filter((s) => s.startsWith('@media')).join(' '), selector, body: text.slice(re.lastIndex, text.indexOf('}', re.lastIndex)) });
    stack.push('rule');
  }
  return out;
}
const flat = () => rules(read('flat-controls.css'));
const own = (selector: string, media = '') => flat().filter((r) => r.media === media && r.selector.split(',').map((s) => s.trim()).includes(selector)).map((r) => r.body).join('\n');

describe('no Aqua drawing is left on any control (FLAT-BTN-001)', () => {
  it('never installs the kit\u2019s button, pop-up and checkbox drawings', () => {
    expect(read('main.tsx')).not.toMatch(/installAquaArt|airwave-art/);
  });

  it('loads the flat faces after the kit and the app sheet, and before the shared contract', () => {
    const imports = [...read('main.tsx').matchAll(/^import '([^']+\.css)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['@now-playing/aqua-ui/airwave-window.css', './styles.css', './flat-controls.css', './button-contract.css']);
  });

  it('has no sheet that points at a drawing or a gel fill', () => {
    const bad: string[] = [];
    for (const f of sheets) {
      for (const r of rules(read(f))) {
        if (/var\(--aq-(?:btn|def|pop|cb)|var\(--gel-|border-image(?:-source)?:\s*(?!none|\s)/.test(r.body)) bad.push(`${f}: ${r.selector.slice(0, 60)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('gives every kit control the app uses a flat face, with the drawing switched off', () => {
    // The kit still carries its Aqua rules for the hub and the companion; this app overrides each one it uses.
    for (const sel of ['.push', '.box', '.seg__btn']) {
      const body = own(sel);
      expect(body, sel).toMatch(/border-image: none;/);
      expect(body, sel).toMatch(/background(?:-color)?: (?!.*gradient)/);
    }
    // Every kit state that swapped the drawing is answered, so none can bring one back.
    const answered = flat().filter((r) => /border-image-source: none;/.test(r.body)).flatMap((r) => r.selector.split(',').map((s) => s.trim()));
    for (const sel of ['.push:active:not([disabled])', '.push[disabled]', 'form:focus-within > .push--default', '.chk input:checked + .box', '.optrow input:checked + .box']) {
      expect(answered, sel).toContain(sel);
    }
    expect(own('form:focus-within > .push--default')).toMatch(/animation: none;/);
  });

  it('fills no button of the app\u2019s own with a gradient either', () => {
    // The selected tab was a three-stop Aqua gel and every round icon button a two-stop one.
    const app = strip(read('styles.css'));
    expect(/\.side__item\.is-on \{([^}]*)\}/.exec(app)?.[1]).toMatch(/background: #0071e3;/);
    expect(/\.side__item\.is-on \{([^}]*)\}/.exec(app)?.[1]).not.toMatch(/gradient|box-shadow/);
    expect(/\n\.iconbtn \{([^}]*)\}/.exec(app)?.[1]).toMatch(/background: #fff;/);
    const glossy: string[] = [];
    for (const f of sheets) {
      for (const r of rules(read(f))) {
        if (!/(?:^|[\s,>])(?:button|\.[\w-]*(?:btn|push|chip|tab|item)[\w-]*)(?![\w-])[^,]*$/.test(r.selector.split(',')[0] ?? '')) continue;
        if (/background(?:-image)?:[^;]*gradient\([^;]*\)/.test(r.body) && !/(?:prog|vol|range|bar|rail|grad|meter)/.test(r.selector)) glossy.push(`${f}: ${r.selector.slice(0, 60)}`);
      }
    }
    expect(glossy).toEqual([]);
  });

  it('keeps a segment a full 44px touch target on a phone', () => {
    // Measured on the phone after the flat pass: "All songs / Set a count" had dropped from 44px to 40px.
    const flat = strip(read('flat-controls.css'));
    const touch = /@media \(max-width: 899px\), \(pointer: coarse\) \{\s*\.seg__btn \{([^}]*)\}/.exec(flat)?.[1] ?? '';
    expect(touch).toMatch(/min-height: var\(--btn-touch, 44px\);/);
    expect(touch).not.toMatch(/\b40px/);
  });

  it('uses no kit control it has not given a flat face', () => {
    const used = new Set<string>();
    for (const f of sources) for (const m of read(f).matchAll(/className=(?:"([^"]*)"|\{[^}]*?'([^']*)')/g)) for (const n of (m[1] ?? m[2] ?? '').split(/\s+/)) used.add(n);
    // Kit families drawn with Aqua art or a gel gradient.
    expect(['pop', 'lcd', 'gear-badge'].filter((n) => used.has(n))).toEqual([]);
  });
});

describe('one flat button, two weights (FLAT-BTN-001)', () => {
  it('fills the main action with the accent the play disc uses, and leaves the rest quiet', () => {
    const root = own(':root');
    expect(root).toMatch(/--flat-accent: #0071e3;/);
    expect(strip(read('styles.css'))).toMatch(/\.tbtn--main \{[^}]*background: #0071e3;/);
    const main = own('.push--default') + own('.push.push--default');
    expect(main).toMatch(/background: var\(--flat-accent\);/);
    expect(main).toMatch(/color: #fff;/);
    const quiet = own('.push');
    expect(quiet).toMatch(/background: var\(--flat-face\);/);
    expect(quiet).toMatch(/border: 1px solid var\(--flat-edge\);/);
    expect(quiet).toMatch(/border-radius: 999px;/);
  });

  it('makes "Find my next favorite" the main action and Stop its quiet neighbour, in one row', () => {
    const app = read('App.tsx');
    const row = app.slice(app.indexOf('className="go__row"'), app.indexOf('id="go-why"'));
    const buttons = [...row.matchAll(/<button className="([^"]*)"/g)].map((m) => m[1]);
    // DISCOVER-TIDY-001: Find (75%) and the Customize icon (25%) side by side, then Stop.
    expect(buttons).toEqual(['push push--default push--big', 'push push--big go__custom', 'push push--big']);
    expect(row).toMatch(/Find my next favorite/);
    expect(row).toMatch(/Stop/);
    // Same height, so the pair reads as one control group.
    expect(own('.push--big')).toMatch(/height: var\(--flat-h-big\);/);
  });

  it('shows a press, and a pointer-over look only where there is a pointer', () => {
    expect(own('.push:active:not([disabled])')).toMatch(/background: /);
    expect(own('.push.push--default:active:not([disabled])')).toMatch(/background: var\(--flat-accent-press\);/);
    expect(flat().filter((r) => /:hover/.test(r.selector) && !r.media.includes('(hover: hover)'))).toEqual([]);
    const over = flat().filter((r) => r.media === '@media (hover: hover)' && r.selector.startsWith('.push:hover'));
    expect(over.map((r) => r.body).join('')).toMatch(/background: /);
  });

  it('is 44px to hit on a touch screen and in the layouts that are 44px tall everywhere', () => {
    const touch = flat().filter((r) => r.media === '@media (max-width: 899px), (pointer: coarse)' && r.selector === '.push');
    expect(touch.map((r) => r.body).join('')).toMatch(/height: var\(--btn-touch\);/);
    expect(flat().some((r) => r.media === '' && /\.album__actions \.push/.test(r.selector) && /height: var\(--btn-touch\);/.test(r.body))).toBe(true);
  });

  it('dims a switched-off button the way every other button dims', () => {
    expect(strip(read('button-contract.css'))).toMatch(/:root button:disabled:not\(\.linkbtn\) \{\s*opacity: var\(--btn-off-opacity\);/);
  });
});
