'use strict';
// Airwave Discovery for Windows: the same web app and engine as the Android APK, in an Electron window.
// No server, no Python, no uv. The page is served from the app's own files over an https origin (so
// wasm, ES modules and YouTube's embed behave as in the APK); music-service requests go through the
// guarded bridge in bridge.cjs; storage is IndexedDB in the app's profile.
const { app, BrowserWindow, ipcMain, protocol, net, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { request } = require('./bridge.cjs');
const { createDownloads } = require('./downloads.cjs');

const APP_HOST = 'appassets.androidplatform.net';
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..', 'web', 'dist');
const MODELS = app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(__dirname, '..', '.data', 'models');

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
let downloads = null;
const dl = () =>
  (downloads ||= createDownloads({
    toolsDir: TOOLS,
    saveDir: path.join(app.getPath('music'), 'Airwave Discovery'),
    tempRoot: path.join(app.getPath('temp'), 'airwave-discovery-jobs'),
    reveal: (file) => shell.showItemInFolder(file),
  }));

ipcMain.handle('aw:http', (_e, json) => request(json));
ipcMain.handle('aw:dl', async (_e, json) => {
  try {
    return dl().handle(JSON.parse(json));
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
});
app.on('before-quit', () => downloads && downloads.shutdown());
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
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.removeMenu();
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

app.whenReady().then(() => {
  // Serve the app (and the bundled audio model) for the app origin; every other https request passes through.
  protocol.handle('https', async (req) => {
    const url = new URL(req.url);
    if (url.host !== APP_HOST) return net.fetch(req, { bypassCustomProtocolHandlers: true });
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
  // The app plays audio from YouTube's embed; allow media and fullscreen, deny every other permission.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'fullscreen'));
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
