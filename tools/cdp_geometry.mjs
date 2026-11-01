// Measures horizontal overflow and clipped interactive elements at several widths over CDP.
const ws = new WebSocket(process.argv[2]);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.value;
ws.onopen = async () => {
  await send('Runtime.enable');
  for (const [w, h] of [[360, 640], [390, 844], [768, 1024], [1280, 800], [1920, 1080]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await new Promise((r) => setTimeout(r, 600));
    const r = await evalJs(`(() => { const vw = document.documentElement.clientWidth; const bad = [...document.querySelectorAll('button,input,a,[role=button]')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > vw + 1 || b.left < -1); }).map(e => (e.textContent||e.placeholder||e.tagName).trim().slice(0,24)); return { overflowPx: document.documentElement.scrollWidth - vw, offscreenControls: bad.slice(0,5), controls: document.querySelectorAll('button,input').length }; })()`);
    console.log(`${w}x${h}`, JSON.stringify(r));
  }
  await send('Emulation.clearDeviceMetricsOverride');
  process.exit(0);
};
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 60000);
