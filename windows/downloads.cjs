'use strict';
/**
 * Windows downloaders: yt-dlp and spotDL, run from files shipped inside the app.
 *
 * The page names a URL, a tool and a format. Everything else is decided here:
 *  - the URL must be https and on the tool's host list (mirrored by web/src/engine/downloads.ts;
 *    download-hosts.test.ts fails when they drift);
 *  - arguments are an array handed to spawn() with no shell, and the URL comes after `--` so it can
 *    never be read as an option;
 *  - `--ignore-config` is first for yt-dlp, so a config file cannot add `--exec`;
 *  - files are written to a private temp folder, then moved to the user's Music folder.
 * Background downloads run `parallel` at a time (settable from cache-config, 1-6, default 2, because each
 * slot is a real yt-dlp process); one foreground job is always additional to them. Progress is real
 * (parsed from the tool's own output) or absent, never invented.
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const YTDLP_HOSTS = ['youtu.be', 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com'];
const SPOTDL_HOSTS = ['open.spotify.com'];
/** One slot is one yt-dlp process, so a desktop takes more of them than a phone. */
const PARALLEL_MIN = 1;
const PARALLEL_MAX = 6;
const PARALLEL_DEFAULT = 2;
const FORMATS = ['mp3', 'm4a', 'opus', 'flac', 'wav', 'original'];
const SPOTDL_FORMATS = ['mp3', 'm4a', 'opus', 'flac', 'wav'];
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'flac', 'opus', 'ogg', 'oga', 'wav', 'webm', 'mka']);

function urlAllowedFor(tool, raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || String(raw).length > 500 || /[\s\x00-\x1f]/.test(String(raw))) return false;
  const host = u.hostname.toLowerCase();
  if (tool === 'spotdl') return SPOTDL_HOSTS.includes(host) && /^\/(intl-[a-z]{2}(-[a-z]{2})?\/)?track\/[A-Za-z0-9]{10,30}\/?$/.test(u.pathname);
  if (tool === 'yt-dlp') return YTDLP_HOSTS.includes(host);
  return false;
}

/** The complete argument list for one job. Nothing here comes from the page except url and format. */
function buildArgs(tool, url, format, dir, ffmpegPath) {
  if (tool === 'yt-dlp') {
    const a = ['--ignore-config', '--no-colors', '--newline', '--no-mtime', '--no-cache-dir', '--no-playlist', '--ffmpeg-location', ffmpegPath, '--paths', dir, '--output', '%(title).180B.%(ext)s', '--extract-audio', '--embed-metadata'];
    if (format !== 'original') a.push('--audio-format', format);
    a.push('--', url);
    return a;
  }
  // spotDL has no "keep the original" mode; it converts, so "original" means mp3 here.
  const fmt = SPOTDL_FORMATS.includes(format) ? format : 'mp3';
  return ['download', url, '--ffmpeg', ffmpegPath, '--format', fmt, '--output', path.join(dir, '{artists} - {title}.{output-ext}')];
}

function safeName(name) {
  const cleaned = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 160);
  return cleaned || 'song';
}

function uniqueIn(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${stem} (${i})${ext}`;
  return path.join(dir, candidate);
}

function lastMeaningfulLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const err = [...lines].reverse().find((l) => /error/i.test(l));
  return (err || lines[lines.length - 1] || '').slice(0, 400) || null;
}

/**
 * @param {{ toolsDir: string, saveDir: string, tempRoot: string, reveal?: (file: string) => void, spawnImpl?: typeof spawn }} cfg
 */
/**
 * Finished downloads, indexed by the link they were fetched from, so the player can ask "do you
 * hold this song?" and play it on a deck. Kept as a small JSON file beside the saved songs; entries
 * whose file has gone are dropped when read.
 */
function createLibrary(saveDir) {
  const file = path.join(saveDir, '.airwave-library.json');
  let map = null;
  function load() {
    if (map) return map;
    map = new Map();
    try {
      for (const [url, p] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) if (typeof p === 'string') map.set(url, p);
    } catch {
      /* no library yet */
    }
    return map;
  }
  function save() {
    fs.mkdirSync(saveDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(load())), 'utf8');
  }
  return {
    get(url) {
      const p = load().get(url);
      if (!p) return null;
      if (!fs.existsSync(p)) {
        load().delete(url);
        save();
        return null;
      }
      return p;
    },
    set(url, p) {
      load().set(url, p);
      save();
    },
  };
}

function createDownloads(cfg) {
  // The queue cache is private and evictable. A deliberate Download is copied to the user's Music
  // folder and never counted against, or removed by, this limit.
  const cacheDir = cfg.cacheDir || path.join(cfg.tempRoot, 'audio-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  let saveDir = cfg.saveDir;
  const library = createLibrary(cfg.libraryDir || saveDir);
  const cacheIndex = path.join(cacheDir, 'index.json');
  const cached = new Map();
  try {
    for (const [url, entry] of Object.entries(JSON.parse(fs.readFileSync(cacheIndex, 'utf8')))) {
      if (urlAllowedFor('yt-dlp', url) && entry && typeof entry.name === 'string' && /^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/.test(entry.name)) {
        const file = path.join(cacheDir, entry.name);
        if (fs.existsSync(file) && fs.statSync(file).isFile()) cached.set(url, { name: entry.name, display: safeName(entry.display || entry.name), at: Number(entry.at) || 0 });
      }
    }
  } catch { /* first run or invalid index */ }
  // A crash after moving an audio file but before writing the index must not leave an invisible,
  // unmetered file behind. This folder is app-private; never scan or remove the user's Music folder.
  const indexedNames = new Set([...cached.values()].map((e) => e.name));
  for (const name of fs.readdirSync(cacheDir)) {
    if (/^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/.test(name) && !indexedNames.has(name)) {
      const orphan = path.join(cacheDir, name);
      if (fs.statSync(orphan).isFile()) fs.unlinkSync(orphan);
    }
  }
  let limitBytes = 1024 ** 3;
  let protectedUrls = new Set();
  let wantedUrls = new Set();
  let backgroundParallel = PARALLEL_DEFAULT;
  const cacheBytes = () => [...cached.values()].reduce((n, e) => n + fs.statSync(path.join(cacheDir, e.name)).size, 0);
  function persistCache() {
    const file = `${cacheIndex}.tmp`;
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(cached)), 'utf8');
    fs.renameSync(file, cacheIndex);
  }
  // Planning and finalization are synchronous: concurrent processes cannot interleave quota/index writes.
  function prune(extra = 0, background = false) {
    let bytes = cacheBytes();
    const discard = [];
    for (const [url, e] of [...cached].sort((a, b) => a[1].at - b[1].at)) {
      if (bytes + extra <= limitBytes) break;
      if (protectedUrls.has(url) || (background && wantedUrls.has(url))) continue;
      discard.push([url, e]);
      bytes -= fs.statSync(path.join(cacheDir, e.name)).size;
    }
    if (bytes + extra > limitBytes) throw new Error('The wanted or protected songs and this download exceed the queue cache limit. Increase it in Settings.');
    for (const [url, e] of discard) {
      fs.unlinkSync(path.join(cacheDir, e.name));
      cached.delete(url);
    }
    persistCache();
  }
  function cachedFile(url) {
    const entry = cached.get(url);
    if (!entry) return null;
    const file = path.join(cacheDir, entry.name);
    if (!fs.existsSync(file)) { cached.delete(url); persistCache(); return null; }
    if (Date.now() - entry.at > 30_000) { entry.at = Date.now(); persistCache(); }
    return file;
  }
  const exe = (n) => path.join(cfg.toolsDir, `${n}.exe`);
  const run = cfg.spawnImpl || spawn;
  /** @type {Map<string, any>} */
  const jobs = new Map();
  const active = { background: 0, foreground: 0 };
  function pump() {
    for (const lane of ['foreground', 'background']) {
      for (const j of jobs.values()) {
        // Read the limit per candidate: lowering it mid-flight stops new starts without touching
        // the processes already running, and raising it takes effect on this same pass.
        if (active[lane] >= (lane === 'background' ? backgroundParallel : 1)) break;
        if (j.state !== 'queued' || j.cancelled || j.dispatched || (j.background ? 'background' : 'foreground') !== lane) continue;
        active[lane]++;
        j.dispatched = true;
        execute(j).catch(e => fail(j, e.message || String(e))).finally(() => {
          fs.rm(j.dir, { recursive: true, force: true }, () => undefined);
          active[lane]--;
          pump();
        });
      }
    }
  }
  let versions = null;

  function probe() {
    if (versions) return versions;
    const get = (name, args, pick) => {
      if (!fs.existsSync(exe(name))) return { id: name, present: false, version: null, method: 'missing', detail: `${name}.exe is not in the app's tools folder.` };
      const r = spawnSync(exe(name), args, { encoding: 'utf8', timeout: 45_000, windowsHide: true });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      const version = r.status === 0 ? pick(out) : null;
      return { id: name, present: Boolean(version), version, method: 'the real tool, shipped inside this app', detail: version ? null : `Could not run ${name}.exe: ${lastMeaningfulLine(out) || r.error?.message || 'no output'}` };
    };
    versions = [get('yt-dlp', ['--version'], (o) => o.trim().split(/\s+/)[0] || null), get('spotdl', ['--version'], (o) => (/\d+\.\d+\.\d+/.exec(o) || [])[0] || null), get('ffmpeg', ['-version'], (o) => (/version\s+(\S+)/.exec(o) || [])[1] || null)];
    return versions;
  }

  function view(j) {
    return { id: j.id, url: j.url, tool: j.tool, format: j.format, label: j.label, state: j.state, stage: j.stage, percent: j.percent, message: j.message, error: j.error, files: j.files.map((f) => ({ name: f.name, bytes: f.bytes })), saved_to: j.saved_to };
  }

  function health() {
    const tools = probe();
    // The queue cache is the app's real audio footprint. The page shows it next to the limit the
    // owner sets, so it must come from disk here, not from the WebView's own storage estimate.
    return { ready: tools.every((t) => t.present), runs_spotdl: true, tools, saves_to: saveDir, cache_bytes: cacheBytes(), cache_limit_bytes: limitBytes };
  }

  function keep(url) {
    if (!urlAllowedFor('yt-dlp', url)) throw new Error('Not a link this app downloads from.');
    const ongoing = [...jobs.values()].find((j) => j.url === url && (j.state === 'queued' || j.state === 'running'));
    if (ongoing) { ongoing.keep = true; return { job: view(ongoing) }; }
    const source = library.get(url) || cachedFile(url);
    if (!source) return { job: null };
    let dest = library.get(url);
    if (!dest || path.dirname(dest) !== saveDir) {
      fs.mkdirSync(saveDir, { recursive: true });
      dest = uniqueIn(saveDir, cached.has(url) ? cached.get(url).display : safeName(path.basename(source)));
      // Copy first and index only after success: playback stays on its original file/blob.
      fs.copyFileSync(source, dest);
      library.set(url, dest);
    }
    const j = { id: crypto.randomUUID(), url, tool: 'yt-dlp', format: 'original', label: path.basename(dest), state: 'done', stage: 'done', percent: 100, message: null, error: null, files: [{ name: path.basename(dest), path: dest, bytes: fs.statSync(dest).size }], saved_to: saveDir };
    jobs.set(j.id, j);
    return { job: view(j) };
  }

  function fail(j, reason) {
    j.state = j.cancelled ? 'cancelled' : 'failed';
    j.stage = 'done';
    j.error = j.cancelled ? null : String(reason).slice(0, 600);
  }

  async function execute(j) {
    if (j.cancelled) return;
    const tool = j.tool;
    if (!fs.existsSync(exe(tool)) || !fs.existsSync(exe('ffmpeg'))) return fail(j, `${tool} is not available in this build.`);
    fs.mkdirSync(j.dir, { recursive: true });
    j.state = 'running';
    j.stage = 'fetching';
    const args = buildArgs(tool, j.url, j.format, j.dir, exe('ffmpeg'));
    if (j.cache) args.splice(args.indexOf('--'), 0, '--max-filesize', String(limitBytes));
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' };
    const code = await new Promise((resolve) => {
      let child;
      try {
        child = run(exe(tool), args, { cwd: j.dir, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        j.errText = e.message;
        return resolve(-1);
      }
      j.child = child;
      let tail = '';
      const onData = (buf) => {
        for (const raw of buf.toString('utf8').split(/\r?\n|\r/)) {
          const line = raw.trim();
          if (!line) continue;
          tail = `${tail}\n${line}`.slice(-4000);
          const pct = /\[download\]\s+([\d.]+)%/.exec(line);
          if (pct) j.percent = Math.min(100, Number(pct[1]));
          if (/^\[(ExtractAudio|Merger|Metadata|EmbedThumbnail)\]/.test(line) || /^Converting|^Downloaded /.test(line)) j.stage = 'converting';
          j.message = line.slice(0, 300);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (e) => {
        j.errText = e.message;
        resolve(-1);
      });
      child.on('close', (c) => {
        j.errText = j.errText || tail;
        resolve(c);
      });
    });
    j.child = null;
    if (j.cancelled) return fail(j, 'cancelled');
    if (code !== 0) return fail(j, lastMeaningfulLine(j.errText) || `${tool} exited with code ${code}.`);

    j.stage = 'finalizing';
    const found = [];
    const walk = (d, depth) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (e.isFile() && AUDIO_EXT.has(path.extname(e.name).slice(1).toLowerCase())) found.push(p);
      }
    };
    walk(j.dir, 0);
    if (found.length === 0) return fail(j, `${tool} finished without producing an audio file.`);
    if (j.cache) {
      if (found.length !== 1) return fail(j, 'A song must produce exactly one audio file to enter the queue cache.');
      const src = found[0];
      const bytes = fs.statSync(src).size;
      if (bytes > limitBytes) return fail(j, 'This song is larger than the queue cache limit. Increase it in Settings.');
      try { prune(bytes, j.background); } catch (e) { return fail(j, e.message); }
      const name = `${j.id}${path.extname(src).toLowerCase()}`;
      const dest = path.join(cacheDir, name);
      try { fs.renameSync(src, dest); } catch { fs.copyFileSync(src, dest); }
      cached.set(j.url, { name, display: safeName(path.basename(src)), at: Date.now() });
      persistCache();
      j.files.push({ name: path.basename(src), path: dest, bytes });
      j.saved_to = 'Queue cache (temporary)';
      if (j.keep) {
        const permanent = uniqueIn(saveDir, safeName(path.basename(src)));
        fs.mkdirSync(saveDir, { recursive: true });
        fs.copyFileSync(dest, permanent);
        library.set(j.url, permanent);
        j.files = [{ name: path.basename(permanent), path: permanent, bytes }];
        j.saved_to = saveDir;
      }
    } else {
      fs.mkdirSync(saveDir, { recursive: true });
      for (const src of found.sort()) {
        const dest = uniqueIn(saveDir, safeName(path.basename(src)));
        try { fs.renameSync(src, dest); } catch { fs.copyFileSync(src, dest); }
        j.files.push({ name: path.basename(dest), path: dest, bytes: fs.statSync(dest).size });
      }
      j.saved_to = saveDir;
      // Register whichever tool produced it. Gating this on yt-dlp meant a finished spotdl song was
      // never recorded, so the app could not tell it already held the file and a second Download
      // wrote "Artist - Title (2).opus" instead of reusing it.
      if (j.files.length === 1) library.set(j.url, j.files[0].path);
    }
    j.state = 'done';
    j.stage = 'done';
    j.percent = 100;
  }

  function start({ url, tool, format, label, cache = false, background = false }) {
    if (tool !== 'yt-dlp' && tool !== 'spotdl') throw new Error('Unknown tool.');
    if (cache && (tool !== 'yt-dlp' || format !== 'original')) throw new Error('The playback cache accepts only original full songs.');
    if (!FORMATS.includes(format)) throw new Error('Unsupported format.');
    if (!urlAllowedFor(tool, url)) throw new Error(tool === 'spotdl' ? 'spotDL takes a Spotify track link (open.spotify.com/track/…).' : 'yt-dlp downloads from YouTube, YouTube Music and SoundCloud links.');
    const existing = [...jobs.values()].find((x) => x.url === url && (x.state === 'queued' || x.state === 'running'));
    if (existing) {
      if (!background) existing.background = false;
      queueMicrotask(pump);
      return view(existing);
    }
    const running = [...jobs.values()].filter((x) => x.state === 'queued' || x.state === 'running').length;
    if (running >= 20) throw new Error('Too many downloads are waiting. Let some finish first.');
    const id = crypto.randomUUID();
    const j = { id, url, tool, format, cache: Boolean(cache), background: Boolean(background), label: String(label || '').slice(0, 200), state: 'queued', stage: 'queued', percent: null, message: null, error: null, files: [], saved_to: null, cancelled: false, child: null, errText: '', dir: path.join(cfg.tempRoot, id) };
    jobs.set(id, j);
    queueMicrotask(pump);
    return view(j);
  }

  function killTree(child) {
    if (!child || !child.pid) return;
    // yt-dlp and spotDL are PyInstaller one-file programs: the visible process has a child.
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  }

  function cancel(id) {
    const j = jobs.get(id);
    if (!j) return false;
    if (j.state === 'queued' || j.state === 'running') {
      j.cancelled = true;
      killTree(j.child);
      if (j.state === 'queued') {
        j.state = 'cancelled';
        j.stage = 'done';
      }
    }
    return true;
  }

  /**
   * Spotify search by spotDL's own `save` command. spotDL writes the songs it finds to a JSON file
   * (no download happens); the file is read and deleted here. Bounded: 45 s and a 2 MB answer.
   */
  function searchSpotify(query, limit) {
    const q = String(query || '').trim().slice(0, 200);
    if (!q) return { songs: [] };
    if (!fs.existsSync(exe('spotdl'))) throw new Error("spotDL is not in the app's tools folder.");
    fs.mkdirSync(cfg.tempRoot, { recursive: true });
    const file = path.join(cfg.tempRoot, `search-${crypto.randomUUID()}.spotdl`);
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' };
    try {
      const r = spawnSync(exe('spotdl'), ['save', q, '--save-file', file, '--log-level', 'ERROR'], { env, windowsHide: true, shell: false, encoding: 'utf8', timeout: 45_000, maxBuffer: 2_000_000 });
      if (r.error) throw new Error(`spotDL could not run: ${r.error.message}`);
      if (!fs.existsSync(file)) throw new Error(lastMeaningfulLine(`${r.stdout || ''}
${r.stderr || ''}`) || 'spotDL found nothing for that search.');
      const size = fs.statSync(file).size;
      if (size > 2_000_000) throw new Error('spotDL answered with more than 2 MB.');
      const songs = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { songs: Array.isArray(songs) ? songs.slice(0, Math.max(1, Math.min(25, Number(limit) || 12))) : [] };
    } finally {
      fs.rm(file, { force: true }, () => undefined);
    }
  }

  function handle(req) {
    switch (req.op) {
      case 'health':
        return health();
      case 'spotify-search':
        return searchSpotify(req.query, req.limit);
      case 'start':
        return { job: start(req) };
      case 'jobs':
        return { jobs: [...jobs.values()].map(view) };
      case 'cache-config': {
        const gb = Number(req.limitGb);
        if (!Number.isFinite(gb) || gb < 0.25 || gb > 20) throw new Error('Queue cache size must be between 0.25 and 20 GB.');
        const urls = (name, max, fallback) => {
          const list = req[name] === undefined ? fallback : req[name];
          if (!Array.isArray(list) || list.length > max || list.some(url => typeof url !== 'string' || !urlAllowedFor('yt-dlp', url))) throw new Error(`${name} must contain at most ${max} valid URLs.`);
          return new Set(list);
        };
        // Omitting parallel keeps whatever is in force; a bad value is refused, never quietly clamped.
        let nextParallel = backgroundParallel;
        if (req.parallel !== undefined) {
          if (typeof req.parallel !== 'number' || !Number.isInteger(req.parallel) || req.parallel < PARALLEL_MIN || req.parallel > PARALLEL_MAX) {
            throw new Error(`parallel must be a whole number of background downloads between ${PARALLEL_MIN} and ${PARALLEL_MAX}.`);
          }
          nextParallel = req.parallel;
        }
        const nextProtected = urls('protected', 3, []);
        const nextWanted = urls('wanted', 10000, []);
        const previousLimit = limitBytes;
        const previousProtected = protectedUrls;
        limitBytes = Math.floor(gb * 1024 ** 3);
        protectedUrls = nextProtected;
        try { prune(); } catch (e) { limitBytes = previousLimit; protectedUrls = previousProtected; throw e; }
        wantedUrls = nextWanted;
        backgroundParallel = nextParallel;
        for (const j of jobs.values()) if (j.cache && !wantedUrls.has(j.url) && !protectedUrls.has(j.url) && (j.state === 'queued' || j.state === 'running')) cancel(j.id);
        // A raised limit must start queued songs now, not when a running download happens to end.
        pump();
        return { bytes: cacheBytes(), limitBytes, parallel: backgroundParallel };
      }
      case 'keep':
        return keep(String(req.url || ''));
      case 'choose-folder':
        if (!cfg.chooseFolder) throw new Error('Folder picker is unavailable.');
        return Promise.resolve(cfg.chooseFolder(saveDir)).then((dir) => {
          if (!dir) return { saves_to: saveDir };
          fs.mkdirSync(dir, { recursive: true });
          saveDir = dir;
          return { saves_to: saveDir };
        });
      case 'cancel':
        return { ok: cancel(String(req.id)) };
      case 'forget': {
        cancel(String(req.id));
        return { ok: jobs.delete(String(req.id)) };
      }
      case 'local': {
        // What the shell holds for a link: the finished file, or whether a job for it is running.
        const url = String(req.url || '');
        // Either downloader's link is a fair question: asking "do you hold this?" about a Spotify
        // track used to throw, so the app could never see a finished spotdl download.
        if (!urlAllowedFor('yt-dlp', url) && !urlAllowedFor('spotdl', url)) throw new Error('Not a link this app downloads from.');
        // `kept` and `cached` are reported separately: the card badge must distinguish a permanent
        // Music-folder copy from an evictable queue-cache entry. `file` is either, for playback.
        const keptPath = library.get(url);
        const cachedPath = cachedFile(url);
        const p = keptPath || cachedPath;
        const running = [...jobs.values()].some((j) => j.url === url && (j.state === 'queued' || j.state === 'running'));
        const failed = [...jobs.values()].reverse().find((j) => j.url === url && j.state === 'failed');
        return { file: p ? { name: path.basename(p), bytes: fs.statSync(p).size } : null, kept: Boolean(keptPath), cached: Boolean(cachedPath), running, error: !p && !running ? failed?.error || null : null };
      }
      case 'reveal': {
        const j = jobs.get(String(req.id));
        const f = j && j.files[0];
        if (!f) return { ok: false };
        if (cfg.reveal) cfg.reveal(f.path);
        return { ok: true };
      }
      default:
        throw new Error('Unknown request.');
    }
  }

  function shutdown() {
    for (const j of jobs.values()) {
      j.cancelled = true;
      killTree(j.child);
    }
  }

  /** The file held for a link, for the shell to serve at the app origin; null when there is none. */
  const localFile = (url) => (urlAllowedFor('yt-dlp', url) ? library.get(url) || cachedFile(url) : null);

  return { handle, health, shutdown, localFile };
}

module.exports = { createDownloads, buildArgs, urlAllowedFor, safeName, YTDLP_HOSTS, SPOTDL_HOSTS, FORMATS };
