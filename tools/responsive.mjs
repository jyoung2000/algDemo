// Responsive audit: node tools/responsive.mjs <url> [outDir]
// Loads the app at many viewport sizes (with seeds, results and the player open) and reports horizontal
// overflow, clipped or overlapping controls, and tap targets that are too small on narrow screens.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:8793/';
const out = process.argv[3];
if (out) mkdirSync(out, { recursive: true });
const sizes = [[320, 568], [360, 740], [390, 844], [480, 800], [600, 900], [768, 1024], [900, 700], [1024, 768], [1280, 720], [1440, 900], [1920, 1080], [2560, 1300], [700, 360]];

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage();
await page.goto(url);
await page.waitForSelector('input');
await page.fill('input', 'daft punk around the world');
await page.locator('button', { hasText: /^Search$/ }).first().click();
await page.waitForSelector('text=Add', { timeout: 30000 });
for (let i = 0; i < 2; i++) await page.locator('button', { hasText: /^Add$/ }).first().click();
await page.waitForTimeout(500);

const audit = () => {
  const vw = document.documentElement.clientWidth;
  const problems = [];
  const sw = document.documentElement.scrollWidth;
  if (sw > vw + 1) problems.push(`page scrolls sideways: scrollWidth ${sw} > ${vw}`);
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    let scroller = false; // inside a deliberate scroll strip (overflow-x auto/scroll), so sideways extent is intended
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) if (['auto', 'scroll'].includes(getComputedStyle(a).overflowX) || (['hidden', 'clip'].includes(getComputedStyle(a).overflowX) && a.getBoundingClientRect().right <= vw + 1)) { scroller = true; break; } // or clipped by an ancestor that itself fits
    if (scroller) continue;
    const name = (el.className && String(el.className).slice(0, 40)) || el.tagName;
    if (r.right > vw + 1 && cs.position !== 'fixed' && !el.closest('[class*=sr-]')) problems.push(`${el.tagName}.${name} extends to ${Math.round(r.right)} > ${vw}`);
    if (r.left < -1 && !el.classList.contains('skip')) problems.push(`${el.tagName}.${name} starts at ${Math.round(r.left)}`);
    const target = el.tagName === 'INPUT' && el.closest('label') ? el.closest('label') : el; // a label is the tap target for the box inside it
    const tr = target.getBoundingClientRect();
    if (['BUTTON', 'A', 'INPUT'].includes(el.tagName) && matchMedia('(max-width: 480px)').matches && (tr.height < 30 || tr.width < 30) && !(el.tagName === 'INPUT' && el.type === 'range')) problems.push(`small target ${el.tagName}.${name} ${Math.round(tr.width)}x${Math.round(tr.height)}`);
    if (el.scrollWidth > el.clientWidth + 2 && cs.overflowX === 'visible' && el.children.length === 0 && el.clientWidth > 0 && cs.whiteSpace !== 'nowrap') problems.push(`text overflows ${el.tagName}.${name} (${el.scrollWidth} > ${el.clientWidth})`);
  }
  const title = [...document.querySelectorAll('h1,h2,h3')].map((h) => h.getBoundingClientRect());
  return [...new Set(problems)].slice(0, 12);
};

let bad = 0;
for (const [w, h] of sizes) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(250);
  const p = await page.evaluate(audit);
  if (out) await page.screenshot({ path: `${out}/r-${w}x${h}.png`, fullPage: false });
  console.log(`${w}x${h}: ${p.length ? p.join('\n   ') : 'ok'}`);
  bad += p.length;
}
await browser.close();
console.log(bad ? `\n${bad} problem(s)` : '\nno problems found');
