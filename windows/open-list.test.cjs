'use strict';
/**
 * LIST-FOLDER-001 in the Windows shell. Owner: "add a button where the user can open the local folder
 * with the current song list / queue". `open-list` lays the list's downloaded songs out in
 * <music folder>\Song lists\<list name>, numbered in play order, with an .m3u8 beside them, and opens
 * that folder. Files are hard links to the downloads (no second copy on the same drive); opening the
 * list again replaces only what the app put there.
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
  const dir = fs.mkdtempSync(path.join(scratch, 'aw-list-test-'));
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

test('lays the downloaded songs out in play order, with a playlist, and opens the folder', async (t) => {
  const { dir, dl, opened } = fixture(t);
  await download(dl, url('aaaaaaaaaaa'));
  await download(dl, url('ccccccccccc'));
  const r = dl.handle({ op: 'open-list', name: 'Late night', songs: [
    { url: url('aaaaaaaaaaa'), title: 'Yale', artist: 'Ken Carson' },
    { url: url('bbbbbbbbbbb'), title: 'Not here', artist: 'Nobody' },
    { url: url('ccccccccccc'), title: 'Succubus?', artist: 'Ken Carson' },
  ] });
  const folder = path.join(dir, 'music', 'Song lists', 'Late night');
  assert.deepEqual(r, { ok: true, held: 2, total: 3, folder });
  assert.deepEqual(opened, [folder]);
  const names = fs.readdirSync(folder).filter((n) => !n.startsWith('.')).sort();
  assert.deepEqual(names, ['01 Yale - Ken Carson.opus', '02 Succubus_ - Ken Carson.opus', 'Late night.m3u8']);
  assert.equal(fs.readFileSync(path.join(folder, '01 Yale - Ken Carson.opus'), 'utf8'), `audio of ${url('aaaaaaaaaaa')}`);
  assert.equal(fs.readFileSync(path.join(folder, 'Late night.m3u8'), 'utf8'),
    '#EXTM3U\r\n#EXTINF:-1,Ken Carson - Yale\r\n01 Yale - Ken Carson.opus\r\n#EXTINF:-1,Ken Carson - Succubus?\r\n02 Succubus_ - Ken Carson.opus\r\n');
  // A hard link, not a copy: the same file on disk as the download.
  const src = dl.localFile(url('aaaaaaaaaaa'));
  assert.equal(fs.statSync(path.join(folder, '01 Yale - Ken Carson.opus')).ino, fs.statSync(src).ino);
});

test('opening again replaces only what the app put there, and keeps the owner\u2019s own files', async (t) => {
  const { dir, dl } = fixture(t);
  await download(dl, url('aaaaaaaaaaa'));
  await download(dl, url('ccccccccccc'));
  const songs = [{ url: url('aaaaaaaaaaa'), title: 'Yale', artist: 'Ken Carson' }, { url: url('ccccccccccc'), title: 'Succubus', artist: 'Ken Carson' }];
  dl.handle({ op: 'open-list', name: 'Late night', songs });
  const folder = path.join(dir, 'music', 'Song lists', 'Late night');
  fs.writeFileSync(path.join(folder, 'my notes.txt'), 'mine');
  dl.handle({ op: 'open-list', name: 'Late night', songs: [songs[1]] });
  const names = fs.readdirSync(folder).filter((n) => !n.startsWith('.')).sort();
  assert.deepEqual(names, ['01 Succubus - Ken Carson.opus', 'Late night.m3u8', 'my notes.txt']);
});

test('refuses links the app does not download from, and names that climb out of the folder', async (t) => {
  const { dir, dl } = fixture(t);
  const r = dl.handle({ op: 'open-list', name: '..\\..\\Windows', songs: [{ url: 'https://evil.example/x', title: 'x', artist: 'y' }] });
  assert.equal(r.held, 0);
  assert.ok(r.folder.startsWith(path.join(dir, 'music', 'Song lists') + path.sep), r.folder);
});
