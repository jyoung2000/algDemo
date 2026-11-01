const ws = new WebSocket(process.argv[2]);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ws.onopen = async () => {
  await send('Runtime.enable');
  for (let i = 0; i < 8; i++) {
    const s = await evalJs(`(() => ({ finding: [...document.querySelectorAll('button')].some(b => /Finding/.test(b.textContent)), queueRows: document.querySelectorAll('.queue li, .queue__row, [class*=queue] li').length, hasQueueFoot: !!document.querySelector('.queue__foot'), status: (document.querySelector('[role=status],[aria-live]')||{}).textContent || null }))()`);
    console.log(`t=${i * 5}s`, JSON.stringify(s));
    await sleep(5000);
  }
  const tail = await evalJs(`document.body.innerText.match(/Your last queue[^\n]*|Finding[^\n]*|queue[^\n]{0,80}/gi)?.slice(0,6)`);
  console.log('MATCHES:', JSON.stringify(tail));
  process.exit(0);
};
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 90000);
