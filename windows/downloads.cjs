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
 * One job runs at a time; progress is real (parsed from the tool's own output) or absent, never invented.
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const YTDLP_HOSTS = ['youtu.be', 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com'];
const SPOTDL_HOSTS = ['open.spotify.com'];
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
function createDownloads(cfg) {
  const exe = (n) => path.join(cfg.toolsDir, `${n}.exe`);
  const run = cfg.spawnImpl || spawn;
  /** @type {Map<string, any>} */
  const jobs = new Map();
  let chain = Promise.resolve();
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
    return { ready: tools.every((t) => t.present), runs_spotdl: true, tools, saves_to: cfg.saveDir };
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
    fs.mkdirSync(cfg.saveDir, { recursive: true });
    for (const src of found.sort()) {
      const dest = uniqueIn(cfg.saveDir, safeName(path.basename(src)));
      try {
        fs.renameSync(src, dest);
      } catch {
        fs.copyFileSync(src, dest); // a different drive: rename cannot cross it
      }
      j.files.push({ name: path.basename(dest), path: dest, bytes: fs.statSync(dest).size });
    }
    j.saved_to = cfg.saveDir;
    j.state = 'done';
    j.stage = 'done';
    j.percent = 100;
  }

  function start({ url, tool, format, label }) {
    if (tool !== 'yt-dlp' && tool !== 'spotdl') throw new Error('Unknown tool.');
    if (!FORMATS.includes(format)) throw new Error('Unsupported format.');
    if (!urlAllowedFor(tool, url)) throw new Error(tool === 'spotdl' ? 'spotDL takes a Spotify track link (open.spotify.com/track/…).' : 'yt-dlp downloads from YouTube, YouTube Music and SoundCloud links.');
    const running = [...jobs.values()].filter((x) => x.state === 'queued' || x.state === 'running').length;
    if (running >= 20) throw new Error('Too many downloads are waiting. Let some finish first.');
    const id = crypto.randomUUID();
    const j = { id, url, tool, format, label: String(label || '').slice(0, 200), state: 'queued', stage: 'queued', percent: null, message: null, error: null, files: [], saved_to: null, cancelled: false, child: null, errText: '', dir: path.join(cfg.tempRoot, id) };
    jobs.set(id, j);
    chain = chain.then(() => execute(j)).catch((e) => fail(j, e.message || String(e))).finally(() => {
      fs.rm(j.dir, { recursive: true, force: true }, () => undefined);
    });
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
      case 'cancel':
        return { ok: cancel(String(req.id)) };
      case 'forget': {
        cancel(String(req.id));
        return { ok: jobs.delete(String(req.id)) };
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

  return { handle, health, shutdown };
}

module.exports = { createDownloads, buildArgs, urlAllowedFor, safeName, YTDLP_HOSTS, SPOTDL_HOSTS, FORMATS };
