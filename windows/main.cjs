'use strict';
// Airwave Discovery for Windows: the same web app and engine as the Android APK, in an Electron window.
// No server, no Python, no uv. The page is served from the app's own files over an https origin (so
// wasm, ES modules and YouTube's embed behave as in the APK); music-service requests go through the
// guarded bridge in bridge.cjs; storage is IndexedDB in the app's profile.
const { app, BrowserWindow, ipcMain, protocol, net, shell, session, dialog, powerSaveBlocker } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { request } = require('./bridge.cjs');
const { createDownloads } = require('./downloads.cjs');
const { createStreams } = require('./streams.cjs');
const { createHls } = require('./hls.cjs');

const APP_HOST = 'appassets.androidplatform.net';
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..', 'web', 'dist');
const MODELS = app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(__dirname, '..', '.data', 'models');

const AUDIO_MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm', mka: 'audio/x-matroska' };
const MIME = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', wasm: 'application/wasm', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', woff2: 'font/woff2', md: 'text/plain' };

// A custom https handler needs the scheme registered as standard + secure before ready.
protocol.registerSchemesAsPrivileged([{ scheme: 'https', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

function fileFor(urlPath) {
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  const isModel = rel.startsWith('models/');
  const base = isModel ? MODELS : ROOT;
  if (isModel) rel = rel.slice('models/'.length);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null; // no path traversal
  return full;
}

app.setName('Airwave Discovery');
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

const TOOLS = app.isPackaged ? path.join(process.resourcesPath, 'tools') : path.join(__dirname, '..', '.data', 'tools');
const MUSIC_CHOICE = path.join(app.getPath('userData'), 'music-folder.json');
function savedMusicFolder() {
  try {
    const folder = JSON.parse(fs.readFileSync(MUSIC_CHOICE, 'utf8')).folder;
    if (typeof folder === 'string' && path.isAbsolute(folder) && fs.statSync(folder).isDirectory()) return folder;
  } catch { /* no chosen folder */ }
  return path.join(app.getPath('music'), 'Airwave Discovery');
}
let downloads = null;
// STREAM-DL-001: a chosen song plays from its source while its download runs.
let streams = null;
let hls = null;
const hlsAudio = () => (hls ||= createHls({ toolsDir: TOOLS }));
const stream = () => (streams ||= createStreams({ toolsDir: TOOLS }));
const dl = () =>
  (downloads ||= createDownloads({
    toolsDir: TOOLS,
    streams: true,
    saveDir: savedMusicFolder(),
    libraryDir: path.join(app.getPath('music'), 'Airwave Discovery'),
    cacheDir: path.join(app.getPath('userData'), 'queue-audio'),
    tempRoot: path.join(app.getPath('temp'), 'airwave-discovery-jobs'),
    chooseFolder: async (current) => {
      const result = await dialog.showOpenDialog(win, { title: 'Choose where to keep downloaded music', defaultPath: current, properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || !result.filePaths[0]) return null;
      fs.writeFileSync(MUSIC_CHOICE, JSON.stringify({ folder: result.filePaths[0] }), 'utf8');
      return result.filePaths[0];
    },
    reveal: (file) => shell.showItemInFolder(file),
    // LIST-FOLDER-001: the folder a song list was laid out in, opened in Explorer.
    openFolder: (folder) => void shell.openPath(folder),
  }));

const trusted = (event) => event.sender === win?.webContents && event.senderFrame === event.sender.mainFrame && (() => {
  try { const u = new URL(event.senderFrame.url); return u.protocol === 'https:' && u.host === APP_HOST; } catch { return false; }
})();
ipcMain.handle('aw:http', (event, json) => {
  if (!trusted(event)) return { error: 'Untrusted frame.' };
  return request(json);
});
ipcMain.handle('aw:dl', async (event, json) => {
  if (!trusted(event)) return { error: 'Untrusted frame.' };
  try {
    return await dl().handle(JSON.parse(json));
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
});
let suspensionBlocker = null;
ipcMain.on('aw:playback', (event, playing) => {
  if (!trusted(event) || typeof playing !== 'boolean') return;
  if (playing && suspensionBlocker === null) suspensionBlocker = powerSaveBlocker.start('prevent-app-suspension');
  else if (!playing && suspensionBlocker !== null) {
    powerSaveBlocker.stop(suspensionBlocker);
    suspensionBlocker = null;
  }
});
app.on('before-quit', () => {
  downloads?.shutdown();
  if (suspensionBlocker !== null) powerSaveBlocker.stop(suspensionBlocker);
});
ipcMain.on('aw:version', (e) => {
  e.returnValue = app.getVersion();
});

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 360,
    minHeight: 520,
    backgroundColor: '#f7f6f3',
    title: 'Airwave Discovery',
    icon: path.join(__dirname, '..', 'launcher', 'airwave-discovery.ico'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.removeMenu();
  win.webContents.on('render-process-gone', () => {
    if (suspensionBlocker !== null) { powerSaveBlocker.stop(suspensionBlocker); suspensionBlocker = null; }
  });
  win.on('closed', () => {
    if (suspensionBlocker !== null) { powerSaveBlocker.stop(suspensionBlocker); suspensionBlocker = null; }
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).host !== APP_HOST) {
      e.preventDefault();
      if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  void win.loadURL(`https://${APP_HOST}/index.html`);
}

async function serveLocalAudio(req, sourceUrl) {
  const file = dl().localFile(sourceUrl);
  if (!file) return new Response('Not Found', { status: 404 });
  const size = fs.statSync(file).size;
  const type = AUDIO_MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
  let start = 0;
  let end = size - 1;
  if (range) {
    if (!range[1]) {
      const suffix = Number(range[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return new Response('', { status: 416, headers: { 'content-range': `bytes */${size}` } });
      start = Math.max(0, size - suffix);
    } else {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    }
    if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size)) return new Response('', { status: 416, headers: { 'content-range': `bytes */${size}` } });
  }
  const stream = fs.createReadStream(file, { start, end });
  const body = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
      stream.on('end', () => controller.close());
      stream.on('error', (e) => controller.error(e));
    },
    cancel() {
      stream.destroy();
    },
  });
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      'content-type': type,
      'accept-ranges': 'bytes',
      'content-length': String(end - start + 1),
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
      'cache-control': 'no-cache',
    },
  });
}

app.whenReady().then(() => {
  // Serve the app (and the bundled audio model) for the app origin; every other https request passes through.
  protocol.handle('https', async (req) => {
    const url = new URL(req.url);
    if (url.host !== APP_HOST) return net.fetch(req, { bypassCustomProtocolHandlers: true });
    // A downloaded full song, served at the app's own origin so the page may route it through Web
    // Audio (a cross-origin element without CORS is silent there). Range requests, because an
    // <audio> element seeks with them and will not report a duration without them.
    if (url.pathname === '/local-audio') return serveLocalAudio(req, url.searchParams.get('u') || '');
    // STREAM-DL-001: the same song from its source, while the download is still running.
    if (url.pathname === '/stream-audio') return stream().serve(req, url.searchParams.get('u') || '');
    if (url.pathname === '/hls-info') return hlsAudio().info(url.searchParams.get('u') || '');
    if (url.pathname === '/hls-resource') return hlsAudio().resource(req, url.searchParams.get('t') || '', url.searchParams.get('i') || '');
    let file = fileFor(url.pathname);
    if (!file) return new Response('Forbidden', { status: 403 });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (path.extname(url.pathname)) return new Response('Not Found', { status: 404 });
      file = path.join(ROOT, 'index.html'); // client-side routes
    }
    const ext = path.extname(file).slice(1).toLowerCase();
    const r = await net.fetch(pathToFileURL(file).toString(), { bypassCustomProtocolHandlers: true });
    return new Response(r.body, { status: 200, headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' } });
  });
  // Fullscreen for YouTube's embed; the microphone for the search bar's Mic (song identification), and only for
  // the app's own page and never the camera. Every other permission is denied. Windows' own microphone privacy
  // switch still applies; when it is off the page gets NotAllowedError and says where to turn it on.
  const fromApp = (u) => {
    try {
      return new URL(u).host === APP_HOST;
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (permission === 'fullscreen') return cb(true);
    if (permission !== 'media') return cb(false);
    const types = (details && details.mediaTypes) || [];
    cb(fromApp((details && details.requestingUrl) || wc.getURL()) && types.length > 0 && types.every((t) => t === 'audio'));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === 'fullscreen' || (permission === 'media' && fromApp(origin)));
  // YouTube's embed refuses to play (error 153) when the request carries no Referer. The page comes from a
  // custom handler, which Chromium sends none for, so give embed and player requests the app origin, as
  // the Android WebView does.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube-nocookie.com/*', 'https://www.youtube.com/*'] }, (details, cb) => {
    const headers = { ...details.requestHeaders };
    if (!headers.Referer && !headers.referer) headers.Referer = `https://${APP_HOST}/`;
    cb({ requestHeaders: headers });
  });
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on('window-all-closed', () => app.quit());
