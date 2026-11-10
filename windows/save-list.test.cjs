'use strict';
/**
 * LIST-SAVE-FOLDER-001 in the Windows shell. Owner: "add an option to quick download entire saved
 * playlist / album and download into seperated folder for just those tracks". `save-list` puts the
 * songs of one saved list or album in a folder of their own (<music folder>\Albums\<artist - album>
 * or <music folder>\Lists\<list name>), numbered in the list's order, with an .m3u8 beside them. It is
 * called again as more songs finish, adds only what is new, and never removes a song already there.
 * The folder copy is kept: the app plays it offline and the cache limit can no longer remove it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createDownloads } = require('./downloads.cjs');

const scratch = path.join(process.env.LOCALAPPDATA, 'hermes', 'cache', 'scratch');
const url = (id) => `https://music.youtube.com/watch?v=${id}`;

function fixture(t) {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'aw-save-test-'));
  fs.writeFileSync(path.join(dir, 'yt-dlp.exe'), 'fixture');
  fs.writeFileSync(path.join(dir, 'ffmpeg.exe'), 'fixture');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opened = [];
  const dl = createDownloads({
    toolsDir: dir, saveDir: path.join(dir, 'music'), cacheDir: path.join(dir, 'cache'), tempRoot: path.join(dir, 'tmp'),
    openFolder: (p) => opened.push(p),
    spawnImpl(_program, args) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.pid = 0; child.kill = () => {};
      process.nextTick(() => {
        const jobDir = args[args.indexOf('--paths') + 1];
        fs.mkdirSync(jobDir, { recursive: true });
        fs.writeFileSync(path.join(jobDir, 'full-song.opus'), `audio of ${args.at(-1)}`);
        child.emit('close', 0);
      });
      return child;
    },
  });
  return { dir, dl, opened };
}
async function download(dl, link) {
  dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [link] });
  const { job } = dl.handle({ op: 'start', url: link, tool: 'yt-dlp', format: 'original', label: 'x', cache: true });
  for (let n = 0; n < 200; n++) {
    const j = dl.handle({ op: 'jobs' }).jobs.find((x) => x.id === job.id);
    if (j.state === 'done') return;
    if (j.state === 'failed') throw new Error(j.error);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('download did not finish');
}
const songs = [
  { url: url('aaaaaaaaaaa'), title: 'Green Room', artist: 'Ken Carson', n: 1 },
  { url: url('bbbbbbbbbbb'), title: 'Jennifer\u2019s Body', artist: 'Ken Carson', n: 2 },
  { url: url('ccccccccccc'), title: 'Singapore?', artist: 'Ken Carson', n: 3 },
];
const listed = (folder) => fs.readdirSync(folder).filter((n) => !n.startsWith('.')).sort();

test('puts an album in a folder of its own as its songs finish, in album order, and keeps them', async (t) => {
  const { dir, dl, opened } = fixture(t);
  await download(dl, url('aaaaaaaaaaa'));
  const folder = path.join(dir, 'music', 'Albums', 'Ken Carson - A Great Chaos');
  // First call: one song is in, two are still coming.
  const r1 = dl.handle({ op: 'save-list', kind: 'album', name: 'Ken Carson - A Great Chaos', songs, total: 3 });
  assert.deepEqual(r1, { ok: true, held: 1, total: 3, folder });
  assert.deepEqual(listed(folder), ['01 Green Room - Ken Carson.opus', 'Ken Carson - A Great Chaos.m3u8']);
  assert.deepEqual(opened, [], 'saving does not open the folder by itself');
  // The rest arrive; the same call adds only what is new, numbered by the album's order, not arrival.
  await download(dl, url('ccccccccccc'));
  dl.handle({ op: 'save-list', kind: 'album', name: 'Ken Carson - A Great Chaos', songs, total: 3 });
  await download(dl, url('bbbbbbbbbbb'));
  const r2 = dl.handle({ op: 'save-list', kind: 'album', name: 'Ken Carson - A Great Chaos', songs, total: 3 });
  assert.equal(r2.held, 3);
  assert.deepEqual(listed(folder), ['01 Green Room - Ken Carson.opus', '02 Jennifer\u2019s Body - Ken Carson.opus', '03 Singapore_ - Ken Carson.opus', 'Ken Carson - A Great Chaos.m3u8']);
  assert.equal(fs.readFileSync(path.join(folder, 'Ken Carson - A Great Chaos.m3u8'), 'utf8'),
    '#EXTM3U\r\n#EXTINF:-1,Ken Carson - Green Room\r\n01 Green Room - Ken Carson.opus\r\n#EXTINF:-1,Ken Carson - Jennifer\u2019s Body\r\n02 Jennifer\u2019s Body - Ken Carson.opus\r\n#EXTINF:-1,Ken Carson - Singapore?\r\n03 Singapore_ - Ken Carson.opus\r\n');
  // Kept: the app now plays the folder copy, so clearing the cache cannot take the song away.
  dl.handle({ op: 'cache-clear' });
  assert.equal(dl.localFile(url('aaaaaaaaaaa')), path.join(folder, '01 Green Room - Ken Carson.opus'));
  assert.equal(dl.handle({ op: 'local', url: url('aaaaaaaaaaa') }).kept, true);
  assert.equal(fs.readFileSync(path.join(folder, '01 Green Room - Ken Carson.opus'), 'utf8'), `audio of ${url('aaaaaaaaaaa')}`);
  // A later call that finds a song no longer held anywhere leaves the folder's copy alone.
  const r3 = dl.handle({ op: 'save-list', kind: 'album', name: 'Ken Carson - A Great Chaos', songs: [{ ...songs[0], url: url('ddddddddddd') }, songs[1], songs[2]], total: 3 });
  assert.equal(r3.held, 3);
  assert.ok(fs.existsSync(path.join(folder, '01 Green Room - Ken Carson.opus')));
});

test('saves a list under Lists, opens its folder on request, and says when there is nothing yet', async (t) => {
  const { dir, dl, opened } = fixture(t);
  const empty = dl.handle({ op: 'open-saved', kind: 'list', name: 'Late night' });
  assert.deepEqual(empty, { ok: false, folder: path.join(dir, 'music', 'Lists', 'Late night') });
  await download(dl, url('aaaaaaaaaaa'));
  const r = dl.handle({ op: 'save-list', kind: 'list', name: 'Late night', songs: [songs[0]], total: 1 });
  const folder = path.join(dir, 'music', 'Lists', 'Late night');
  assert.equal(r.folder, folder);
  assert.deepEqual(dl.handle({ op: 'open-saved', kind: 'list', name: 'Late night' }), { ok: true, folder });
  assert.deepEqual(opened, [folder]);
});

test('refuses links the app does not download from, and names that climb out of the folder', async (t) => {
  const { dir, dl } = fixture(t);
  const r = dl.handle({ op: 'save-list', kind: 'album', name: '..\\..\\Windows', songs: [{ url: 'https://evil.example/x', title: 'x', artist: 'y', n: 1 }], total: 1 });
  assert.equal(r.held, 0);
  assert.ok(r.folder.startsWith(path.join(dir, 'music', 'Albums') + path.sep), r.folder);
  assert.throws(() => dl.handle({ op: 'save-list', kind: 'nope', name: 'x', songs: [] }), /album or a list/);
});
