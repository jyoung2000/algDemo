// Live-player check, driven through the real UI over CDP (Windows Electron or the Android WebView).
//   CDP_PORT=9444 node tools/cdp_live_player.mjs
// Runs discovery, plays the first song to its end (fast-forwarded), skips two of the next, and prints
// the order, the song facts and the "learned from" line after each step so the re-rank can be seen.
import WebSocket from 'ws';

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
const ev = async (expression, t = 120) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: t * 1000 });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

const snap = `(() => ({
  taste: (document.querySelector('.note--taste') || {}).innerText || null,
  now: (document.querySelector('.np__title') || {}).innerText || null,
  rows: [...document.querySelectorAll('.rec:not(.rec--seed)')].map((r) => ({
    t: r.querySelector('.rec__title').firstChild.textContent.trim(),
    a: r.querySelector('.rec__artist').innerText,
    f: [...r.querySelectorAll('.fact')].map((f) => f.textContent).join(' ; '),
  })),
}))()`;

const show = (label, s) => {
  console.log(`\n== ${label}\nnow playing: ${s.now}\n${s.taste ? 'taste: ' + s.taste + '\n' : ''}${s.rows.map((r, i) => `${String(i + 1).padStart(2)}. ${r.t.slice(0, 28).padEnd(28)} ${r.a.slice(0, 18).padEnd(18)} ${r.f}`).join('\n')}`);
};

// 1. discover
await ev(`(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const go=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Find my next favorite'));go.click();
  for(let k=0;k<150;k++){await sleep(1000);const g=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Find my')||b.textContent.includes('Finding'));
    if(g&&g.textContent.includes('Find my')&&document.querySelectorAll('.rec:not(.rec--seed)').length&&/compared|Order/.test(document.querySelector('.queue__head').innerText))break;}})()`, 200);
const s0 = await ev(snap);
show('after discovery', s0);

// 2. play row 1 through the real play button, listen to the end
const playRow = (n) => ev(`(async()=>{const r=document.querySelectorAll('.rec:not(.rec--seed)')[${n}];r.querySelector('button[title=Play]').click();await new Promise(r=>setTimeout(r,1500));return document.querySelector('.np__title')?.innerText})()`);
console.log('\nplaying:', await playRow(0));
const audio = await ev(`(async()=>{const a=document.querySelector('audio');if(!a)return 'no audio element';
  a.muted=true;await a.play().catch(()=>0);
  // The meter counts only real, continuous playback (jumps over 1.5 s are ignored), so listen for real.
  await new Promise(r=>setTimeout(r,22000));
  a.currentTime=Math.max(0,(a.duration||30)-0.4);await new Promise(r=>setTimeout(r,3500));return 'ended-ish at '+a.currentTime.toFixed(1)+' dur '+a.duration})()`, 60);
console.log('audio:', audio);
await new Promise((r) => setTimeout(r, 2000));
show('after listening to song 1 to the end', await ev(snap));

// 3. skip twice: play 3 s then press Next
for (let n = 0; n < 2; n++) {
  const r = await ev(`(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));const a=document.querySelector('audio');if(a){a.muted=true;await a.play().catch(()=>0);}await sleep(4000);
    const nb=document.querySelector('button[aria-label="Next song"]');if(!nb||nb.disabled)return 'NEXT BUTTON '+(nb?'disabled':'missing');nb.click();await sleep(2500);return document.querySelector('.np__title')?.innerText})()`);
  console.log(`\nskipped; now playing: ${r}`);
  show(`after skip ${n + 1}`, await ev(snap));
}
ws.close();
process.exit(0);
