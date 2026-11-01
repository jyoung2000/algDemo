// Screenshot + layout measurement of the running app at several viewport sizes over CDP.
//   CDP_PORT=9444 node tools/cdp_shots.mjs <outDir>
import WebSocket from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';

const out = process.argv[2] || '.';
mkdirSync(out, { recursive: true });
const port = process.env.CDP_PORT || 9333;
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(list.find((p) => p.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let id = 0;
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    const h = (m) => {
      const d = JSON.parse(m);
      if (d.id === i) {
        ws.off('message', h);
        d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result);
      }
    };
    ws.on('message', h);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

// Elements whose text is cut off or that stick out of the viewport.
const measure = `(() => {
  const vw = document.documentElement.clientWidth;
  const bad = [];
  for (const el of document.querySelectorAll('.rec__facts, .fact, .note--taste, .dial--count, .rec__why1, .rec__title, .rec__artist')) {
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    if (r.right > vw + 1 || r.left < -1) bad.push(el.className + ' sticks out ' + Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + vw);
  }
  const facts = [...document.querySelectorAll('.rec__facts')].map((f) => Math.round(f.getBoundingClientRect().height));
  return { vw, scrollW: document.documentElement.scrollWidth, hscroll: document.documentElement.scrollWidth > vw + 1, bad, factRowHeights: facts.slice(0, 6) };
})()`;

const sizes = [
  ['desktop-1180x820', 1180, 820, 1, false],
  ['tablet-820x1000', 820, 1000, 1, true],
  ['mobile-390x844', 390, 844, 2, true],
  ['mobile-small-320x640', 320, 640, 2, true],
];
for (const [name, w, h, dpr, mobile] of sizes) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile });
  await new Promise((r) => setTimeout(r, 900));
  const m = await send('Runtime.evaluate', { expression: measure, returnByValue: true });
  console.log(name, JSON.stringify(m.result.value));
  for (const [tag, y] of [['top', 0], ['list', 380]]) {
    await send('Runtime.evaluate', { expression: `window.scrollTo(0, ${y}); (document.querySelector('.results, main, .app')||document.body).scrollTop = ${y}` });
    await new Promise((r) => setTimeout(r, 300));
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${out}/${name}-${tag}.png`, Buffer.from(s.data, 'base64'));
  }
}
await send('Emulation.clearDeviceMetricsOverride');
ws.close();
process.exit(0);
