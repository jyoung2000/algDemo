/*
 * DL-GRADIENT-001 device check: measure the RENDERED pixels of the list availability meter.
 * Usage from a CDP driver that supplies {evalPage, send, sleep}. Writes full-viewport PNGs plus a
 * report.json naming the crop box; analyse-download-gradient.py crops and decides pass/fail.
 *
 * A CSS assertion cannot prove the browser painted the gradient (a stale bundle, an overriding
 * rule, or an unsupported clip-path would all still pass the stylesheet test), so this reads a
 * real screenshot at several fill levels.
 *
 * Screenshots are full-viewport on purpose: Page.captureScreenshot's `clip` was interpreted
 * against a different origin than getBoundingClientRect in the Android WebView here, and the crop
 * silently landed on unrelated chrome while still reporting a confident colour result. Cropping in
 * the analyser from viewport rect * devicePixelRatio is unambiguous.
 */
import fs from 'node:fs';
export async function run({evalPage, send, sleep}, outDir) {
  const dir = outDir ?? process.env.DL_GRADIENT_OUT ?? '.';
  fs.mkdirSync(dir, {recursive: true});
  const report = {samples: []};
  const found = await evalPage(`const b=document.querySelector('[data-testid=list-availability]'); if(!b){const t=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Saved'); t?.click();} return !!document.querySelector('[data-testid=list-availability]');`);
  if (!found) await sleep(1200);
  for (const pct of [25, 60, 100]) {
    // Override only the reveal fraction; the painted gradient itself stays the app's own.
    await evalPage(`const m=document.querySelector('[data-testid=list-availability] [role=meter]'); if(!m)throw Error('No availability meter on screen'); m.style.setProperty('--available','${pct}%'); m.scrollIntoView({block:'center'}); return null;`);
    await sleep(350);
    const rect = await evalPage(`const m=document.querySelector('[data-testid=list-availability] [role=meter]'); const r=m.getBoundingClientRect(); const fill=m.firstElementChild; const cs=getComputedStyle(fill); return {left:r.left,top:r.top,width:r.width,height:r.height,dpr:devicePixelRatio,background:cs.backgroundImage,clipPath:cs.clipPath,fillWidth:fill.getBoundingClientRect().width,innerWidth,innerHeight};`);
    const shot = await send('Page.captureScreenshot', {format: 'png'});
    const file = `${dir}/frame-${pct}.png`;
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    report.samples.push({pct, file, ...rect});
  }
  await evalPage(`document.querySelector('[data-testid=list-availability] [role=meter]')?.style.removeProperty('--available'); return true;`);
  fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.samples.map((s) => ({pct: s.pct, background: s.background, clipPath: s.clipPath})), null, 2));
  return report;
}
