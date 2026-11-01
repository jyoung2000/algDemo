// Adds the first search result as a starting song, then runs "Find my next favorite" in the WebView.
const ws = new WebSocket(process.argv[2]);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ws.onopen = async () => {
  await send('Runtime.enable');
  const clickByText = (label) => `(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === ${JSON.stringify(label)} || x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return 'missing:' + ${JSON.stringify(label)}; b.click(); return 'clicked'; })()`;
  console.log('ADD:', await evalJs(clickByText('Add')));
  await sleep(2000);
  console.log('STARTING:', await evalJs(`document.body.innerText.match(/\d+ starting songs?/)?.[0]`));
  console.log('FIND:', await evalJs(clickByText('Find my next favorite')));
  await sleep(40000);
  const text = await evalJs('document.body.innerText.slice(0, 1400)');
  console.log('QUEUE:', JSON.stringify(text));
  process.exit(0);
};
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 120000);
