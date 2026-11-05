// Usage: node scripts/check-apk-layout.mjs [adb-serial]
// Opens no fake app: inspect the running APK's actual WebView. Requires >=1 Saved song.
import {execFileSync} from 'node:child_process';
import {run} from './apk-list-layout-check.mjs';
const serial=process.argv[2]??'emulator-5554';
const adb=(...args)=>execFileSync('adb',['-s',serial,...args],{encoding:'utf8'}).trim();
const pid=adb('shell','pidof','com.nowplaying.discovery');
if(!pid)throw Error('Start Airwave Discovery on the selected device first.');
const port=adb('forward','tcp:0',`localabstract:webview_devtools_remote_${pid}`);
let ws;
try {
 const pages=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
 const page=pages.find(p=>p.type==='page'&&p.url.includes('appassets.androidplatform.net'));
 if(!page)throw Error('Airwave WebView not found');
 ws=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
 let id=0;const pending=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(Error(`Timed out: ${method}`));},20000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));});
 const evalPage=async body=>{const r=await send('Runtime.evaluate',{expression:`(async()=>{${body}})()`,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await run({send,evalPage,sleep:ms=>new Promise(r=>setTimeout(r,ms))});
 console.log('PASS: populated Saved rows at 320 / 360 / 412 / 1280 CSS px');
} finally {
 ws?.close();adb('forward','--remove',`tcp:${port}`);
}
