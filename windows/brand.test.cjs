// JPLAY-BRAND-001 (owner, 2026-11-19): "rename the app to jPlay with that exact spelling" and use the
// owner's icon. The library and settings stay where earlier versions kept them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./electron-builder.config.cjs');
const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

test('the Windows app is called jPlay and its files say so', () => {
  assert.strictEqual(config.productName, 'jPlay');
  assert.match(config.win.artifactName, /^jPlay-\$\{version\}-/);
  assert.match(config.nsis.artifactName, /^jPlay-\$\{version\}-/);
  assert.match(main, /app\.setName\('jPlay'\)/);
  assert.match(main, /title: 'jPlay'/);
});

test('it uses the owner\'s icon, and the icon is packaged', () => {
  assert.strictEqual(config.win.icon, '../launcher/jplay.ico');
  assert.ok(config.files.includes('../launcher/jplay.ico'));
  assert.ok(fs.statSync(path.join(__dirname, '..', 'launcher', 'jplay.ico')).size > 10000);
  assert.match(main, /'jplay\.ico'/);
});

test('the update keeps the library: the profile folder is moved to jPlay before the app starts', () => {
  // app.setName changes the default profile folder; brand-folders.cjs moves the earlier version's
  // folder to %APPDATA%\\jPlay (or keeps using it when it cannot move), unless a test passes --user-data-dir.
  assert.match(main, /app\.setPath\('userData', brandFolders\.moveProfile\(app\.getPath\('appData'\)\)\)/);
  assert.ok(main.indexOf("app.setPath('userData'") < main.indexOf('requestSingleInstanceLock'));
  // Downloads move to Music\\jPlay and stay known (brand-folders.test.cjs).
  assert.match(main, /libraryDir: musicHome\(\)/);
  // A test profile never moves the owner's real music folder.
  assert.match(main, /hasSwitch\('user-data-dir'\) \? \{ rename: \(\) => \{ throw/);
  assert.doesNotMatch(main, /Airwave Discovery/);
});
