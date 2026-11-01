const ws = new WebSocket(process.argv[2]);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
ws.onopen = async () => {
  await send('Runtime.enable');
  const q = await evalJs(`(() => { const foot = document.querySelector('.queue__foot'); const sec = foot ? foot.closest('section,div') : null; const root = document.querySelector('.queue') || document.querySelector('main'); return { hasQueueClass: !!document.querySelector('.queue'), queueText: (document.querySelector('.queue')||{innerText:''}).innerText.slice(0,900), headings: [...document.querySelectorAll('h1,h2,h3')].map(h=>h.textContent.trim()) }; })()`);
  console.log(JSON.stringify(q, null, 1));
  process.exit(0);
};
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 60000);
