// Profile tab check, driven through the real UI over CDP (Windows Electron or the Android WebView).
//   CDP_PORT=9444 node tools/cdp_profile.mjs [shot.png]
// Opens "Profile", waits for it to load, prints each section, the tiles and the event counts, and
// reports horizontal overflow and any page errors. Exits 1 if a section is missing or the page overflows.
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const port = process.env.CDP_PORT || 9333;
const shot = process.argv[2];
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(list.find((p) => p.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let id = 0;
const errors = [];
ws.on('message', (m) => {
  const d = JSON.parse(m);
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description ?? 'exception');
});
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
const ev = async (expression, t = 60) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: t * 1000 });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
await send('Runtime.enable');

const open = await ev(`(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const b=[...document.querySelectorAll('button,[role=tab]')].find(x=>x.textContent.trim()==='Profile');
  if(!b)return 'Profile tab missing';b.click();
  for(let k=0;k<40;k++){await sleep(250);if(document.querySelector('.profile .tiles'))return 'opened';}
  return 'timeout: '+((document.querySelector('.profile')||{}).innerText||'').slice(0,200)})()`);
console.log('open:', open);

const r = await ev(`(()=>{
  const root=document.querySelector('.profile');if(!root)return null;
  const sections=[...root.querySelectorAll('section h2')].map(h=>h.textContent.trim());
  const tiles=Object.fromEntries([...root.querySelectorAll('.tile')].map(t=>[t.querySelector('.tile__k').textContent,t.querySelector('.tile__v').textContent]));
  const kv=[...root.querySelectorAll('section:first-child .kv > div')].map(d=>d.querySelector('dt').textContent+' = '+d.querySelector('dd').textContent);
  const tables=[...root.querySelectorAll('.ptable')].map(t=>({cap:(t.caption||{}).textContent||'',rows:t.tBodies[0]?t.tBodies[0].rows.length:0}));
  const doc=document.documentElement;
  const wide=[...root.querySelectorAll('*')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.right>doc.clientWidth+1&&!e.closest('.raw')&&!e.closest('details:not([open])')}).slice(0,5).map(e=>e.className+' '+Math.round(e.getBoundingClientRect().right));
  const notes=[...root.querySelectorAll('.note')].map(n=>n.textContent.trim().slice(0,160));
  return {width:doc.clientWidth,overflow:doc.scrollWidth-doc.clientWidth,sections,tiles,kv,tables,wide,notes,
    recent:[...root.querySelectorAll('.plog li')].slice(0,6).map(l=>l.innerText.replace(/\\n/g,' | '))};
})()`);
console.log(JSON.stringify(r, null, 1));
if (shot) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shot, Buffer.from(s.data, 'base64'));
  console.log('shot:', shot);
}
console.log('errors:', errors.length ? errors : 'none');
ws.close();
const want = ['Your profile', 'Listening taste', 'How songs are scored', 'Last discovery run', 'Recent activity', 'Raw data'];
const missing = r ? want.filter((w) => !r.sections.includes(w)) : want;
if (missing.length || !r || r.overflow > 0 || errors.length) {
  console.log('FAIL', { missing, overflow: r?.overflow });
  process.exit(1);
}
console.log('PASS');
process.exit(0);
