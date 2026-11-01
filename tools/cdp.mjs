// Tiny CDP driver for the Android WebView: node tools/cdp.mjs "<js expression>" [timeoutSec]
import WebSocket from 'ws';
const port = process.env.CDP_PORT || 9333;
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let id = 0;
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; const h = (m) => { const d = JSON.parse(m); if (d.id === i) { ws.off('message', h); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method, params })); });
const r = await send('Runtime.evaluate', { expression: process.argv[2], awaitPromise: true, returnByValue: true, timeout: (Number(process.argv[3]) || 30) * 1000 });
console.log(r.exceptionDetails ? 'EXC ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails) : typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value));
ws.close();
