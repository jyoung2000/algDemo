'use strict';
// Gives the page the same AirwaveNative contract the Android WebView has, so the engine runs
// unchanged: request(id, json) -> window.__awHttp, downloads(id, json) -> window.__awDl.
// Nothing else is exposed.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const reply = (fn, id, out) => void webFrame.executeJavaScript(`window.${fn}(${id}, ${JSON.stringify(JSON.stringify(out))})`);

contextBridge.exposeInMainWorld('AirwaveNative', {
  version: () => ipcRenderer.sendSync('aw:version'),
  request: (id, json) => {
    const n = Number(id);
    if (!Number.isInteger(n) || typeof json !== 'string') return;
    ipcRenderer.invoke('aw:http', json).then((out) => reply('__awHttp', n, out));
  },
  downloads: (id, json) => {
    const n = Number(id);
    if (!Number.isInteger(n) || typeof json !== 'string') return;
    ipcRenderer.invoke('aw:dl', json).then((out) => reply('__awDl', n, out));
  },
});
