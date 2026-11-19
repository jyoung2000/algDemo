'use strict';
// jPlay for Windows: the same web app and engine as the Android APK, in an Electron window.
// No server, no Python, no uv. The page is served from the app's own files over an https origin (so
// wasm, ES modules and YouTube's embed behave as in the APK); music-service requests go through the
// guarded bridge in bridge.cjs; storage is IndexedDB in the app's profile.
const { app, BrowserWindow, ipcMain, protocol, net, shell, session, dialog, powerSaveBlocker } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { request } = require('./bridge.cjs');
const { createDownloads } = require('./downloads.cjs');
const { createFolderImport } = require('./folder-import.cjs');
const brandFolders = require('./brand-folders.cjs');
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

// JPLAY-BRAND-001/002: the app is jPlay, and so is its profile folder (library, settings, radio
// favourites). An earlier version's folder is moved to the new name on first start; if it cannot be
// moved it is used where it is, so an update keeps everything. A test profile (--user-data-dir) wins.
app.setName('jPlay');
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', brandFolders.moveProfile(app.getPath('appData')));
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

const TOOLS = app.isPackaged ? path.join(process.resourcesPath, 'tools') : path.join(__dirname, '..', '.data', 'tools');
const radio = require('./radio.cjs').createRadio({ toolsDir: TOOLS, favouritesPath: path.join(app.commandLine.getSwitchValue('user-data-dir') || app.getPath('userData'), 'radio-stations.json'),
  saveRecording: (wave, title) => {
    const dir = dl().health().saves_to;
    fs.mkdirSync(dir, { recursive: true });
    const name = `${title.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 110) || 'Live radio'} - recording excerpt - ${Date.now()}.wav`;
    const file = path.join(dir, name); fs.writeFileSync(file, wave, { flag: 'wx' });
    return { saved_to: dir, file, bytes: wave.length };
  } });
const MUSIC_CHOICE = path.join(app.getPath('userData'), 'music-folder.json');
// FOLDER-IMPORT-001: which of the user's own music folders were imported, kept across restarts.
const folderImport = createFolderImport({ indexPath: path.join(app.getPath('userData'), 'imported-folders.json') });
function savedMusicFolder() {
  try {
    const folder = JSON.parse(fs.readFileSync(MUSIC_CHOICE, 'utf8')).folder;
    if (typeof folder === 'string' && path.isAbsolute(folder) && fs.statSync(folder).isDirectory()) return folder;
  } catch { /* no chosen folder */ }
  return musicHome();
}
// JPLAY-BRAND-002: Music\jPlay; an earlier version's music folder is moved there once (its songs stay known).
let musicHomeDir = null;
function musicHome() {
  // A test profile (--user-data-dir) never moves the real folders: it uses whichever one exists.
  const keep = app.commandLine.hasSwitch('user-data-dir') ? { rename: () => { throw new Error('test profile'); } } : undefined;
  if (!musicHomeDir) musicHomeDir = brandFolders.moveMusic(app.getPath('music'), keep);
  return musicHomeDir;
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
    libraryDir: musicHome(),
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
    const req = JSON.parse(json);
    // FOLDER-IMPORT-001: imported songs answer from their own folder; the downloader never sees them.
    const imported = folderImport.dlAnswer(req);
    if (imported) return imported;
    return await dl().handle(folderImport.scrub(req));
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
});
// FOLDER-IMPORT-001: pick folders to import, scan them for audio, and keep the imported list.
ipcMain.handle('aw:folders', async (event, json) => {
  if (!trusted(event)) return { error: 'Untrusted frame.' };
  try {
    const req = JSON.parse(json);
    switch (req.op) {
      case 'pick': {
        const result = await dialog.showOpenDialog(win, { title: 'Choose music folders to import', properties: ['openDirectory', 'multiSelections'] });
        return { folders: result.canceled ? [] : result.filePaths };
      }
      case 'import':
        return folderImport.addFolder(String(req.folder || ''));
      case 'rescan': {
        // Re-read a folder already on the list (to re-register its songs); never adds a new one.
        const known = folderImport.list().some((f) => f.folder === req.folder);
        if (!known) throw new Error('That folder is not imported.');
        return folderImport.addFolder(String(req.folder));
      }
      case 'list':
        return { folders: folderImport.list() };
      case 'remove':
        return folderImport.removeFolder(String(req.folder || ''));
      default:
        throw new Error('Unknown request.');
    }
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
});
let suspensionBlocker = null;
/**
 * FAST-PLAY-002. Owner: "I want to be able to play a song instantly when i click on it on all
 * platforms". Name the source's audio file now so a click does not wait for yt-dlp: the answer goes
 * into the same 20-minute stream cache /stream-audio reads, and a failure is only logged — nothing
 * is waiting on it.
 */
ipcMain.on('aw:warm', (event, url) => {
  if (!trusted(event) || typeof url !== 'string' || url.length > 2048) return;
  if (!stream().streamable(url)) return;
  void stream().resolve(url).catch(() => {});
});

ipcMain.on('aw:playback', (event, playing) => {
  if (!trusted(event) || typeof playing !== 'boolean') return;
  if (playing && suspensionBlocker === null) suspensionBlocker = powerSaveBlocker.start('prevent-app-suspension');
  else if (!playing && suspensionBlocker !== null) {
    powerSaveBlocker.stop(suspensionBlocker);
    suspensionBlocker = null;
  }
});
app.on('before-quit', () => {
  radio.shutdown();
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
    title: 'jPlay',
    icon: path.join(__dirname, '..', 'launcher', 'jplay.ico'),
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
  // FOLDER-IMPORT-001: an imported song's own file serves exactly like a downloaded one.
  const file = dl().localFile(sourceUrl) || folderImport.importedFile(sourceUrl);
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
    if (url.pathname === '/radio-native') {
      try { const q = url.searchParams.get('q') || '{}'; if (q.length > 1000000) throw Error('Radio request too large'); const value = await radio.handle(JSON.parse(q)); return Response.json(value, { headers: { 'Cache-Control': 'no-store' } }); }
      catch (e) { return Response.json({ error: e.message }, { status: 400 }); }
    }
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
