// JPLAY-BRAND-002 (owner, 2026-11-19: "ensure its called jPlay in all places it was called airwave
// discovery on all platforms"): the folders move to their jPlay names without losing a song or a setting.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { moveProfile, moveMusic, LEGACY, NAME } = require('./brand-folders.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jplay-folders-'));
const lib = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.airwave-library.json'), 'utf8'));

test('names', () => { assert.strictEqual(NAME, 'jPlay'); assert.strictEqual(LEGACY, 'Airwave Discovery'); });

test('the profile folder is renamed to jPlay, settings and library inside it', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, LEGACY, 'IndexedDB'), { recursive: true });
  fs.writeFileSync(path.join(root, LEGACY, 'IndexedDB', 'db'), 'library');
  const dir = moveProfile(root);
  assert.strictEqual(dir, path.join(root, 'jPlay'));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'IndexedDB', 'db'), 'utf8'), 'library');
  assert.ok(!fs.existsSync(path.join(root, LEGACY)));
});

test('a profile that cannot be moved (the old app still open) is used where it is', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, LEGACY));
  const dir = moveProfile(root, { rename: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } });
  assert.strictEqual(dir, path.join(root, LEGACY));
});

test('a new install, or one already moved, uses the jPlay folder', () => {
  const root = tmp();
  assert.strictEqual(moveProfile(root), path.join(root, 'jPlay'));
  fs.mkdirSync(path.join(root, 'jPlay'));
  fs.mkdirSync(path.join(root, LEGACY));
  assert.strictEqual(moveProfile(root), path.join(root, 'jPlay'));
});

test('downloaded songs move to Music\\jPlay and stay known, so none is downloaded again', () => {
  const music = tmp();
  const old = path.join(music, LEGACY);
  fs.mkdirSync(path.join(old, 'Albums', 'A'), { recursive: true });
  fs.writeFileSync(path.join(old, 'song.mp3'), 'x');
  fs.writeFileSync(path.join(old, 'Albums', 'A', '01 t.mp3'), 'y');
  fs.writeFileSync(path.join(old, '.airwave-library.json'), JSON.stringify({ 'https://a/1': path.join(old, 'song.mp3'), 'https://a/2': path.join(old, 'Albums', 'A', '01 t.mp3'), 'https://a/3': 'D:\\Elsewhere\\x.mp3' }));
  const dir = moveMusic(music);
  assert.strictEqual(dir, path.join(music, 'jPlay'));
  const l = lib(dir);
  assert.strictEqual(l['https://a/1'], path.join(dir, 'song.mp3'));
  assert.strictEqual(l['https://a/2'], path.join(dir, 'Albums', 'A', '01 t.mp3'));
  assert.strictEqual(l['https://a/3'], 'D:\\Elsewhere\\x.mp3');
  for (const p of Object.values(l).slice(0, 2)) assert.ok(fs.existsSync(p));
});

test('when both folders exist the old one stays, but its songs stay known', () => {
  const music = tmp();
  const old = path.join(music, LEGACY);
  const neu = path.join(music, 'jPlay');
  fs.mkdirSync(old); fs.mkdirSync(neu);
  fs.writeFileSync(path.join(old, 'a.mp3'), 'x');
  fs.writeFileSync(path.join(old, '.airwave-library.json'), JSON.stringify({ 'https://a/1': path.join(old, 'a.mp3') }));
  fs.writeFileSync(path.join(neu, '.airwave-library.json'), JSON.stringify({ 'https://a/2': path.join(neu, 'b.mp3') }));
  assert.strictEqual(moveMusic(music), neu);
  const l = lib(neu);
  assert.strictEqual(l['https://a/1'], path.join(old, 'a.mp3'));
  assert.strictEqual(l['https://a/2'], path.join(neu, 'b.mp3'));
  // Moving again changes nothing.
  assert.strictEqual(moveMusic(music), neu);
  assert.deepStrictEqual(lib(neu), l);
});

test('a music folder that cannot be moved is kept where it is', () => {
  const music = tmp();
  fs.mkdirSync(path.join(music, LEGACY));
  assert.strictEqual(moveMusic(music, { rename: () => { throw new Error('EPERM'); } }), path.join(music, LEGACY));
});
