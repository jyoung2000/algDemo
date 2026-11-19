// JPLAY-BRAND-002 (owner, 2026-11-19: "ensure its called jPlay in all places it was called airwave
// discovery on all platforms"). The app's own folders carry the jPlay name. Earlier versions used the
// old name, so on start the old folders are moved, never copied or deleted; when a move is not
// possible (the old app still has the folder open) the old folder is used as it is, so nothing is lost.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'jPlay';
/** The name earlier versions used: only here, to find their folders. */
const LEGACY = 'Airwave Discovery';
const LIBRARY = '.airwave-library.json';

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const readLibrary = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, LIBRARY), 'utf8')) || {}; } catch { return {}; } };

/** Moves `<root>\Airwave Discovery` to `<root>\jPlay` when only the old one exists; returns the folder to use. */
function moveFolder(root, { rename = fs.renameSync } = {}) {
  const neu = path.join(root, NAME);
  const old = path.join(root, LEGACY);
  if (exists(neu) || !exists(old)) return { dir: neu, moved: false, old };
  try { rename(old, neu); return { dir: neu, moved: true, old }; } catch { return { dir: old, moved: false, old }; }
}

/** The app profile (library database, settings): %APPDATA%\jPlay. Call before the app is ready. */
function moveProfile(appData, opts) { return moveFolder(appData, opts).dir; }

/**
 * Music\jPlay, where downloads are kept. The download index maps links to absolute paths, so paths
 * under the old folder are rewritten after a move; when both folders exist the old folder's index is
 * merged in (its songs stay where they are, still known), so no song is downloaded again.
 */
function moveMusic(music, opts) {
  const { dir, moved, old } = moveFolder(music, opts);
  if (dir === old) return dir;
  const prefix = old + path.sep;
  const fix = (p) => (typeof p === 'string' && (p.toLowerCase().startsWith(prefix.toLowerCase())) && moved ? path.join(dir, p.slice(prefix.length)) : p);
  const merged = { ...(moved ? {} : readLibrary(old)) };
  for (const [url, p] of Object.entries(readLibrary(dir))) merged[url] = p;
  const out = Object.fromEntries(Object.entries(merged).map(([u, p]) => [u, fix(p)]));
  const before = JSON.stringify(readLibrary(dir));
  if (Object.keys(out).length && JSON.stringify(out) !== before) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LIBRARY), JSON.stringify(out), 'utf8');
  }
  return dir;
}

module.exports = { NAME, LEGACY, moveProfile, moveMusic };
