// Drives the Airwave Discovery WebView over CDP (adb forward to webview_devtools_remote_*).
const ws = new WebSocket(process.argv[2]);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
const logs = [];
ws.onopen = async () => {
  await send('Runtime.enable'); await send('Log.enable');
  const bodyText = async () => (await send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0,600)', returnByValue: true })).result?.value;
  console.log('INITIAL:', JSON.stringify(await bodyText()));
  const query = 'daft punk get lucky';
  await send('Runtime.evaluate', { expression: `(() => { const i = document.querySelector('input[type=search],input[type=text],input'); if (!i) return 'no input'; const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(i, ${JSON.stringify(query)}); i.dispatchEvent(new Event('input',{bubbles:true})); i.form?.requestSubmit ? i.form.requestSubmit() : i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 'typed'; })()`, returnByValue: true });
  await new Promise((r) => setTimeout(r, 12000));
  console.log('AFTER SEARCH:', JSON.stringify(await bodyText()));
  const errs = (await send('Runtime.evaluate', { expression: 'window.__airwaveErrors ? window.__airwaveErrors.length : 0', returnByValue: true })).result?.value;
  console.log('ERRORS (instrumented):', errs);
  process.exit(0);
};
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 90000);
