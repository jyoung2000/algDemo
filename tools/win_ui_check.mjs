import { chromium } from 'playwright';
const SHOT = 'C:/Users/jalon/AppData/Local/hermes/cache/scratch';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const out = {};
for (const [name, vp] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport: vp });
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const search = page.locator('input').first();
  await search.fill('daft punk get lucky');
  await search.press('Enter');
  await page.waitForTimeout(12000);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const text = (await page.evaluate(() => document.body.innerText)).slice(0, 300);
  await page.screenshot({ path: `${SHOT}/win-${name}.png`, fullPage: false });
  out[name] = { errors: errs, horizontalOverflowPx: overflow, sawApple: text.includes('Apple'), sample: text.slice(0, 160).replace(/\n/g, ' | ') };
  await page.close();
}
console.log(JSON.stringify(out, null, 1));
await browser.close();
