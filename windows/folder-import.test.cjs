'use strict';
// FOLDER-IMPORT-001: pure logic of the folder importer — name-derived titles, the scan filter,
// the persisted folder registry round-trip, and the bridge answers for imported links.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFolderImport, titleArtist, IMPORT_PREFIX } = require('./folder-import.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-folder-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const indexPath = path.join(dir, 'state', 'imported-folders.json');
  return { dir, indexPath, imp: createFolderImport({ indexPath }) };
}

function musicFolder(dir, name = 'Road Trip') {
  const folder = path.join(dir, name);
  fs.mkdirSync(path.join(folder, 'cd1'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'Daft Punk - One More Time.mp3'), 'aaaa');
  fs.writeFileSync(path.join(folder, '02 - Africa.opus'), 'bb');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'not audio');
  fs.writeFileSync(path.join(folder, '.hidden.mp3'), 'hidden');
  fs.writeFileSync(path.join(folder, 'cd1', 'Bonus.flac'), 'cc');
  return folder;
}

test('titleArtist reads "Artist - Title" and keeps anything else as the whole title', () => {
  assert.deepEqual(titleArtist('Daft Punk - One More Time.mp3'), { artist: 'Daft Punk', title: 'One More Time' });
  assert.deepEqual(titleArtist('03 - Daft Punk - One More Time.flac'), { artist: 'Daft Punk', title: 'One More Time' });
  assert.deepEqual(titleArtist('A - B - C.ogg'), { artist: 'A', title: 'B - C' });
  assert.deepEqual(titleArtist('track01.wav'), { artist: '', title: 'track01' });
  assert.deepEqual(titleArtist('07. Clarity.m4a'), { artist: '', title: 'Clarity' });
});

test('scan finds only audio, skips dotfiles, recurses, and derives names', (t) => {
  const { dir, imp } = fixture(t);
  const folder = musicFolder(dir);
  const r = imp.addFolder(folder);
  assert.equal(r.name, 'Road Trip');
  const names = r.songs.map((s) => s.name).sort();
  assert.deepEqual(names, ['02 - Africa.opus', 'Bonus.flac', 'Daft Punk - One More Time.mp3']);
  const one = r.songs.find((s) => s.name.endsWith('.mp3'));
  assert.equal(one.title, 'One More Time');
  assert.equal(one.artist, 'Daft Punk');
  assert.ok(one.url.startsWith(IMPORT_PREFIX));
  assert.equal(one.bytes, 4);
  const africa = r.songs.find((s) => s.name.endsWith('.opus'));
  assert.deepEqual({ t: africa.title, a: africa.artist }, { t: 'Africa', a: '' });
});

test('the folder registry survives a restart (persistence round-trip)', (t) => {
  const { dir, indexPath, imp } = fixture(t);
  const folder = musicFolder(dir);
  const { songs } = imp.addFolder(folder);
  // A fresh instance over the same index file — "the app restarted".
  const again = createFolderImport({ indexPath });
  assert.deepEqual(again.list().map((f) => f.folder), [folder]);
  assert.equal(again.list()[0].present, true);
  assert.equal(again.importedFile(songs[0].url), songs[0].path);
  // Removing forgets it for the next instance too, and its files stop being servable.
  again.removeFolder(folder);
  const third = createFolderImport({ indexPath });
  assert.deepEqual(third.list(), []);
  assert.equal(third.importedFile(songs[0].url), null);
});

test('importedFile refuses anything outside a registered folder', (t) => {
  const { dir, imp } = fixture(t);
  const folder = musicFolder(dir);
  imp.addFolder(folder);
  const outside = path.join(dir, 'outside.mp3');
  fs.writeFileSync(outside, 'zz');
  assert.equal(imp.importedFile(IMPORT_PREFIX + outside), null);
  assert.equal(imp.importedFile(IMPORT_PREFIX + path.join(folder, '..', 'outside.mp3')), null);
  assert.equal(imp.importedFile(IMPORT_PREFIX + path.join(folder, 'notes.txt')), null); // not audio
  assert.equal(imp.importedFile('https://example.com/a.mp3'), null); // not an imported link
  assert.equal(imp.importedFile(IMPORT_PREFIX + path.join(folder, 'gone.mp3')), null); // vanished
});

test('dlAnswer serves imported links like local files and never downloads them', (t) => {
  const { dir, imp } = fixture(t);
  const folder = musicFolder(dir);
  const { songs } = imp.addFolder(folder);
  const song = songs.find((s) => s.name.endsWith('.mp3'));
  const local = imp.dlAnswer({ op: 'local', url: song.url });
  assert.deepEqual(local, { file: { name: song.name, bytes: 4 }, kept: true, cached: false, running: false, error: null });
  fs.rmSync(song.path);
  const gone = imp.dlAnswer({ op: 'local', url: song.url });
  assert.equal(gone.file, null);
  assert.match(gone.error, /no longer in its folder/);
  assert.match(imp.dlAnswer({ op: 'start', url: song.url }).error, /cannot be downloaded/);
  // Requests about ordinary links pass through untouched.
  assert.equal(imp.dlAnswer({ op: 'local', url: 'https://youtu.be/aaaaaaaaaaa' }), null);
});

test('scrub drops imported links from cache-config and leaves everything else alone', (t) => {
  const { imp } = fixture(t);
  const req = { op: 'cache-config', limitGb: 1, protected: [`${IMPORT_PREFIX}C:\\m\\a.mp3`, 'https://youtu.be/aaaaaaaaaaa'], wanted: [`${IMPORT_PREFIX}C:\\m\\b.mp3`] };
  const out = imp.scrub(req);
  assert.deepEqual(out.protected, ['https://youtu.be/aaaaaaaaaaa']);
  assert.deepEqual(out.wanted, []);
  assert.equal(out.limitGb, 1);
  assert.deepEqual(req.protected.length, 2, 'the original request is not mutated');
  const other = { op: 'local', url: 'https://youtu.be/aaaaaaaaaaa' };
  assert.equal(imp.scrub(other), other);
});

// ---- IMPORT-GENRES-001: the file's own title, artist and genre --------------------------------
const { readTags } = require('./folder-import.cjs');

const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const syncsafe4 = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
/** An ID3v2.3 (or 2.4) tag with text frames, then some fake audio. */
function id3(frames, ver = 3) {
  const body = Buffer.concat(frames.map(([id, enc, text]) => {
    const data = Buffer.concat([Buffer.from([enc]), enc === 1 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : Buffer.from(text, enc === 3 ? 'utf8' : 'latin1')]);
    return Buffer.concat([Buffer.from(id, 'latin1'), ver === 4 ? syncsafe4(data.length) : be32(data.length), Buffer.from([0, 0]), data]);
  }));
  const padded = Buffer.concat([body, Buffer.alloc(64)]);
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([ver, 0, 0]), syncsafe4(padded.length), padded, Buffer.alloc(256, 0xff)]);
}
function vorbisComment(fields) {
  const vendor = Buffer.from('test vendor');
  const list = fields.map((f) => { const s = Buffer.from(f, 'utf8'); return Buffer.concat([le32(s.length), s]); });
  return Buffer.concat([le32(vendor.length), vendor, le32(fields.length), ...list]);
}
function write(t, name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-tags-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return { dir, p };
}

test('readTags reads ID3v2.3 text frames and resolves a numbered genre', (t) => {
  const { p } = write(t, 'track01.mp3', id3([['TIT2', 0, 'Sicko Mode'], ['TPE1', 1, 'Travis Scott'], ['TCON', 0, '(7)']]));
  assert.deepEqual(readTags(p), { title: 'Sicko Mode', artist: 'Travis Scott', genre: 'Hip-Hop' });
});

test('readTags reads ID3v2.4 UTF-8 frames with several artists and genres', (t) => {
  const { p } = write(t, 'x.mp3', id3([['TIT2', 3, 'Kickin\u2019 It'], ['TPE1', 3, 'Ken Carson\u0000Destroy Lonely'], ['TCON', 3, 'Rap\u0000Rage']], 4));
  assert.deepEqual(readTags(p), { title: 'Kickin\u2019 It', artist: 'Ken Carson, Destroy Lonely', genre: 'Rap; Rage' });
});

test('readTags falls back to the ID3v1 tail', (t) => {
  const tail = Buffer.alloc(128);
  tail.write('TAG', 0, 'latin1');
  tail.write('Africa', 3, 'latin1');
  tail.write('Toto', 33, 'latin1');
  tail[127] = 17; // Rock
  const { p } = write(t, 'old.mp3', Buffer.concat([Buffer.alloc(500, 0xff), tail]));
  assert.deepEqual(readTags(p), { title: 'Africa', artist: 'Toto', genre: 'Rock' });
});

test('readTags reads FLAC and Opus Vorbis comments', (t) => {
  const vc = vorbisComment(['TITLE=Pink + White', 'ARTIST=Frank Ocean', 'GENRE=rnb']);
  const streaminfo = Buffer.concat([Buffer.from([0x00, 0, 0, 34]), Buffer.alloc(34)]);
  const flac = Buffer.concat([Buffer.from('fLaC', 'latin1'), streaminfo, Buffer.from([0x84, (vc.length >> 16) & 0xff, (vc.length >> 8) & 0xff, vc.length & 0xff]), vc, Buffer.alloc(100)]);
  assert.deepEqual(readTags(write(t, 'a.flac', flac).p), { title: 'Pink + White', artist: 'Frank Ocean', genre: 'rnb' });
  const opus = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(40), Buffer.from('OpusHead', 'latin1'), Buffer.alloc(30), Buffer.from('OggS', 'latin1'), Buffer.alloc(23), Buffer.from('OpusTags', 'latin1'), vorbisComment(['title=Redbone', 'artist=Childish Gambino', 'genre=Funk', 'genre=Soul']), Buffer.alloc(50)]);
  assert.deepEqual(readTags(write(t, 'b.opus', opus).p), { title: 'Redbone', artist: 'Childish Gambino', genre: 'Funk; Soul' });
});

test('readTags never throws and returns blanks for untagged or unreadable files', (t) => {
  assert.deepEqual(readTags(write(t, 'plain.mp3', 'aaaa').p), { title: '', artist: '', genre: '' });
  assert.deepEqual(readTags(path.join(os.tmpdir(), 'no-such-file-aw.mp3')), { title: '', artist: '', genre: '' });
  // A truncated tag whose frame runs past the end: what was readable is kept, nothing is invented.
  const cut = id3([['TIT2', 0, 'Half']]).subarray(0, 30);
  assert.doesNotThrow(() => readTags(write(t, 'cut.mp3', cut).p));
});

test('scan prefers the file\u2019s own tags to its file name and passes the genre on', (t) => {
  const { dir } = write(t, 'track01.mp3', id3([['TIT2', 0, 'Sicko Mode'], ['TPE1', 0, 'Travis Scott'], ['TCON', 0, 'Hip Hop']]));
  fs.writeFileSync(path.join(dir, 'Daft Punk - One More Time.mp3'), 'aaaa');
  const imp = createFolderImport({ indexPath: path.join(dir, 'idx.json') });
  const songs = imp.addFolder(dir).songs;
  const tagged = songs.find((s) => s.name === 'track01.mp3');
  assert.deepEqual({ title: tagged.title, artist: tagged.artist, genre: tagged.genre }, { title: 'Sicko Mode', artist: 'Travis Scott', genre: 'Hip Hop' });
  const named = songs.find((s) => s.name.startsWith('Daft'));
  assert.deepEqual({ title: named.title, artist: named.artist, genre: named.genre }, { title: 'One More Time', artist: 'Daft Punk', genre: undefined });
});
