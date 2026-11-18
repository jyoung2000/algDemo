'use strict';
// FOLDER-IMPORT-001: the user's own music folders, imported as saved playlists.
//
// The page knows each imported file only by an opaque `imported:<absolute path>` link. This module
// owns that link: which folders were imported (persisted in userData, so the list survives
// restarts), which files inside them count as audio, and the answers the downloads bridge gives for
// those links so the player's existing local-file path (dl.local -> /local-audio) plays them as
// full songs on the app's own deck. Nothing here downloads anything, and nothing outside the
// registered folders is ever readable.
const fs = require('node:fs');
const path = require('node:path');

/** The audio the importer picks up. Mirrors AUDIO_MIME in main.cjs for the formats a deck can play. */
const IMPORT_EXTS = ['mp3', 'm4a', 'opus', 'ogg', 'flac', 'wav', 'webm'];
const IMPORT_PREFIX = 'imported:';
/** One folder is capped so a mistaken "import C:\" cannot walk a whole drive into the app. */
const MAX_SONGS = 1000;
const MAX_DEPTH = 4;

/** Case-insensitive on Windows, where C:\Music and c:\music are the same folder. */
const fold = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

/**
 * "03 - Daft Punk - One More Time.mp3" -> { artist: 'Daft Punk', title: 'One More Time' }.
 * Only the common "Artist - Title" shape is read; anything else keeps the whole name as the title,
 * honestly, rather than guessing an artist that is not in the name.
 */
function titleArtist(fileName) {
  let base = fileName.replace(/\.[^.]+$/, '').trim();
  base = base.replace(/^\d{1,3}[\s._-]+(?=\S)/, '').trim(); // a leading track number
  const parts = base.split(' - ');
  if (parts.length >= 2 && parts[0].trim() && parts.slice(1).join(' - ').trim()) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { artist: '', title: base || fileName };
}

// ---- IMPORT-GENRES-001: the file's own title, artist and genre -------------------------------
//
// Read cheaply from the head of the file (and the 128-byte ID3v1 tail): ID3v2.2/2.3/2.4 in MP3s,
// Vorbis comments in FLAC, Ogg Vorbis and Opus. Other formats (M4A, WAV, WebM) keep their
// name-derived title and artist. A tag that cannot be read is simply absent; nothing is guessed.

const HEAD_BYTES = 64 * 1024;
const ID3_MAX = 2 * 1024 * 1024;
/** ID3v1's numbered genres 0-79 (the standard list); a numbered genre outside it is ignored. */
const ID3V1_GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'AlternRock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychadelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock'];

const clean = (s) => String(s || '').replace(/\u0000+$/g, '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 200);

/** "(17)", "17" or "(17)Rock" -> "Rock"; plain words are kept as written. */
function id3Genre(raw) {
  const parts = String(raw || '').split(/\u0000|;/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = /^\((\d{1,3})\)(.*)$/.exec(p) || /^(\d{1,3})$/.exec(p);
    if (!m) return p;
    if (m[2] && m[2].trim()) return m[2].trim();
    return ID3V1_GENRES[Number(m[1])] || '';
  }).filter(Boolean);
  return [...new Set(parts)].join('; ').slice(0, 200);
}

const syncsafe = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);

function textFrame(b) {
  if (!b.length) return '';
  const enc = b[0];
  let d = b.subarray(1);
  let s;
  if (enc === 1 || enc === 2) {
    let be = enc === 2;
    if (d.length >= 2 && d[0] === 0xfe && d[1] === 0xff) { be = true; d = d.subarray(2); }
    else if (d.length >= 2 && d[0] === 0xff && d[1] === 0xfe) { be = false; d = d.subarray(2); }
    const even = Buffer.from(d.subarray(0, d.length - (d.length % 2)));
    if (be) even.swap16();
    s = even.toString('utf16le').replace(/\ufeff/g, '');
  } else s = d.toString(enc === 3 ? 'utf8' : 'latin1');
  return s.replace(/\u0000+$/g, '');
}

/** Title, artist and genre from an ID3v2 tag at the start of `buf`, or null when there is none. */
function readId3v2(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return null;
  const ver = buf[3];
  const flags = buf[5];
  if (ver < 2 || ver > 4 || (ver < 4 && flags & 0x80)) return {}; // whole-tag unsynchronisation: not read
  const end = Math.min(buf.length, 10 + syncsafe(buf, 6));
  let pos = 10;
  if (ver >= 3 && flags & 0x40 && buf.length >= 14) pos += ver === 4 ? syncsafe(buf, 10) : buf.readUInt32BE(10) + 4;
  const ids = ver === 2 ? { TT2: 'title', TP1: 'artist', TCO: 'genre' } : { TIT2: 'title', TPE1: 'artist', TCON: 'genre' };
  const idLen = ver === 2 ? 3 : 4;
  const hdr = ver === 2 ? 6 : 10;
  const out = {};
  while (pos + hdr <= end) {
    const id = buf.toString('latin1', pos, pos + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    const len = ver === 2 ? buf.readUIntBE(pos + 3, 3) : ver === 4 ? syncsafe(buf, pos + 4) : buf.readUInt32BE(pos + 4);
    const start = pos + hdr;
    if (len <= 0 || start + len > end) break;
    const fflags = ver === 2 ? 0 : buf[pos + 9];
    const packed = ver === 4 ? fflags & 0x0e : ver === 3 ? fflags & 0xc0 : 0; // compressed/encrypted/unsynchronised
    const key = ids[id];
    if (key && !out[key] && !packed) out[key] = textFrame(buf.subarray(start, start + len));
    pos = start + len;
  }
  if (out.title) out.title = clean(out.title.split('\u0000')[0]);
  if (out.artist) out.artist = clean(out.artist.split('\u0000').map((a) => a.trim()).filter(Boolean).join(', '));
  if (out.genre) out.genre = id3Genre(out.genre);
  return out;
}

/** The 128-byte ID3v1 tag at the end of an MP3, or null. */
function readId3v1(tail) {
  if (!tail || tail.length !== 128 || tail.toString('latin1', 0, 3) !== 'TAG') return null;
  const g = ID3V1_GENRES[tail[127]];
  return { title: clean(tail.toString('latin1', 3, 33)), artist: clean(tail.toString('latin1', 33, 63)), genre: g || '' };
}

/** A Vorbis comment block (FLAC, Ogg Vorbis, Opus) starting at `i` in `buf`. */
function readVorbisComment(buf, i) {
  const out = {};
  const artists = [];
  const genres = [];
  if (i + 8 > buf.length) return out;
  const vendor = buf.readUInt32LE(i);
  i += 4 + vendor;
  if (i + 4 > buf.length) return out;
  const n = Math.min(buf.readUInt32LE(i), 500);
  i += 4;
  for (let k = 0; k < n && i + 4 <= buf.length; k++) {
    const len = buf.readUInt32LE(i);
    i += 4;
    if (len > buf.length - i) break; // runs past what was read (a large cover picture): stop here
    const s = buf.toString('utf8', i, i + len);
    i += len;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).toUpperCase();
    const val = s.slice(eq + 1).trim();
    if (!val) continue;
    if (key === 'TITLE' && !out.title) out.title = clean(val);
    else if (key === 'ARTIST') artists.push(val);
    else if (key === 'GENRE') genres.push(val);
  }
  if (artists.length) out.artist = clean([...new Set(artists)].join(', '));
  if (genres.length) out.genre = clean([...new Set(genres)].join('; '));
  return out;
}

function readFlac(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'fLaC') return null;
  let i = 4;
  while (i + 4 <= buf.length) {
    const h = buf[i];
    const len = buf.readUIntBE(i + 1, 3);
    if ((h & 0x7f) === 4) return readVorbisComment(buf, i + 4);
    if (h & 0x80) break;
    i += 4 + len;
  }
  return {};
}

function readOgg(buf) {
  if (buf.length < 4 || buf.toString('latin1', 0, 4) !== 'OggS') return null;
  const opus = buf.indexOf('OpusTags', 0, 'latin1');
  if (opus >= 0) return readVorbisComment(buf, opus + 8);
  const vorbis = buf.indexOf(Buffer.from([0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]));
  if (vorbis >= 0) return readVorbisComment(buf, vorbis + 7);
  return {};
}

/**
 * The title, artist and genre a file's own tags state, each '' when absent. Never throws: a file
 * that cannot be opened or parsed just has no tags.
 */
function readTags(file) {
  const none = { title: '', artist: '', genre: '' };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    let head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    fs.readSync(fd, head, 0, head.length, 0);
    let got = null;
    if (head.length >= 10 && head.toString('latin1', 0, 3) === 'ID3') {
      const want = Math.min(size, ID3_MAX, 10 + syncsafe(head, 6));
      if (want > head.length) {
        head = Buffer.alloc(want);
        fs.readSync(fd, head, 0, want, 0);
      }
      got = readId3v2(head) || {};
      if (!got.title || !got.artist || !got.genre) {
        const tail = Buffer.alloc(size >= 128 ? 128 : 0);
        if (tail.length) fs.readSync(fd, tail, 0, 128, size - 128);
        const v1 = readId3v1(tail);
        if (v1) got = { title: got.title || v1.title, artist: got.artist || v1.artist, genre: got.genre || v1.genre };
      }
    } else {
      got = readFlac(head) || readOgg(head);
      if (!got && /\.mp3$/i.test(file) && size >= 128) {
        const tail = Buffer.alloc(128);
        fs.readSync(fd, tail, 0, 128, size - 128);
        got = readId3v1(tail);
      }
    }
    return { ...none, ...Object.fromEntries(Object.entries(got || {}).filter(([, v]) => typeof v === 'string' && v)) };
  } catch {
    return none;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

function createFolderImport(cfg) {
  const indexPath = cfg.indexPath;
  const exts = cfg.exts || IMPORT_EXTS;

  function loadFolders() {
    try {
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const list = Array.isArray(raw && raw.folders) ? raw.folders : [];
      return list.filter((f) => typeof f === 'string' && path.isAbsolute(f));
    } catch {
      return []; // first run or an unreadable index: nothing imported
    }
  }

  function saveFolders(folders) {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const tmp = `${indexPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ folders }), 'utf8');
    fs.renameSync(tmp, indexPath); // atomic: a crash mid-write never corrupts the list
  }

  const audioFile = (name) => exts.includes(path.extname(name).slice(1).toLowerCase());

  /** Every audio file under the folder, depth- and count-capped, in stable name order. */
  function scan(folder) {
    const songs = [];
    const walk = (dir, depth) => {
      if (depth > MAX_DEPTH || songs.length >= MAX_SONGS) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (songs.length >= MAX_SONGS) return;
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile() && audioFile(e.name)) {
          let bytes = 0;
          try { bytes = fs.statSync(full).size; } catch { continue; }
          const named = titleArtist(e.name);
          // IMPORT-GENRES-001: the file's own tags name the song more surely than its file name.
          const own = readTags(full);
          const title = own.title || named.title;
          const artist = own.artist || named.artist;
          const song = { url: IMPORT_PREFIX + full, path: full, name: e.name, title, artist, bytes };
          if (own.genre) song.genre = own.genre;
          songs.push(song);
        }
      }
    };
    walk(folder, 0);
    return songs;
  }

  function addFolder(folder) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Not a folder path.');
    const full = path.resolve(folder);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new Error('That folder does not exist.');
    const folders = loadFolders();
    if (!folders.some((f) => fold(f) === fold(full))) {
      folders.push(full);
      saveFolders(folders);
    }
    return { folder: full, name: path.basename(full) || full, songs: scan(full) };
  }

  function removeFolder(folder) {
    const folders = loadFolders();
    const kept = folders.filter((f) => fold(f) !== fold(String(folder)));
    if (kept.length !== folders.length) saveFolders(kept);
    return { ok: kept.length !== folders.length, folders: kept };
  }

  const list = () =>
    loadFolders().map((f) => ({ folder: f, name: path.basename(f) || f, present: fs.existsSync(f) }));

  /**
   * The absolute file an `imported:` link names, but only when it still sits inside a registered
   * folder and still looks like audio. Anything else — other schemes, traversal out of the folder,
   * a folder the user removed — is null, so /local-audio can never read outside the imports.
   */
  function importedFile(sourceUrl) {
    if (typeof sourceUrl !== 'string' || !sourceUrl.startsWith(IMPORT_PREFIX)) return null;
    const p = sourceUrl.slice(IMPORT_PREFIX.length);
    if (!path.isAbsolute(p) || !audioFile(p)) return null;
    const full = path.resolve(p);
    const inside = loadFolders().some((f) => {
      const root = fold(f);
      return fold(full) === root || fold(full).startsWith(root + path.sep);
    });
    if (!inside) return null;
    try { return fs.statSync(full).isFile() ? full : null; } catch { return null; }
  }

  /**
   * The downloads-bridge answer for a request about an `imported:` link, or null when the request
   * is not about one (then the real downloader handles it unchanged). Shapes mirror
   * downloads.cjs 'local' so the page's library cannot tell the difference.
   */
  function dlAnswer(req) {
    const url = typeof (req && req.url) === 'string' ? req.url : '';
    if (!url.startsWith(IMPORT_PREFIX)) return null;
    if (req.op === 'local') {
      const file = importedFile(url);
      if (!file) {
        return { file: null, kept: false, cached: false, running: false, error: 'This imported song\u2019s file is no longer in its folder. Put it back, or import the folder again.' };
      }
      return { file: { name: path.basename(file), bytes: fs.statSync(file).size }, kept: true, cached: false, running: false, error: null };
    }
    if (req.op === 'start') {
      // There is nothing to download: the song IS the local file. Asking to fetch it means the file vanished.
      return { error: 'This imported song plays from its own folder; it cannot be downloaded. Put the file back, or import the folder again.' };
    }
    return null;
  }

  /**
   * cache-config names the queue's protected/wanted links, and the downloader refuses any it cannot
   * download. Imported links need no cache slot at all (their files live in the user's folder), so
   * they are dropped from the request instead of failing it.
   */
  function scrub(req) {
    if (!req || req.op !== 'cache-config') return req;
    const clean = (v) => (Array.isArray(v) ? v.filter((u) => !(typeof u === 'string' && u.startsWith(IMPORT_PREFIX))) : v);
    const out = { ...req };
    if ('protected' in out) out.protected = clean(out.protected);
    if ('wanted' in out) out.wanted = clean(out.wanted);
    return out;
  }

  return { addFolder, removeFolder, list, scan, importedFile, dlAnswer, scrub, loadFolders };
}

module.exports = { createFolderImport, titleArtist, readTags, IMPORT_EXTS, IMPORT_PREFIX };
