'use strict';
// PACKAGE-FILES-001: the packaged app crashed at start ("Cannot find module './folder-import.cjs'")
// because electron-builder's file list was written by hand and missed new main-process modules.
// Every module the main process requires must be in the package.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('every ./x.cjs the main-process modules require is packaged', () => {
  const config = require('./electron-builder.config.cjs');
  const files = new Set(config.files);
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const src = fs.readFileSync(path.join(__dirname, name), 'utf8');
    for (const m of src.matchAll(/require\('\.\/([\w.-]+\.cjs)'\)/g)) visit(m[1]);
  };
  visit('main.cjs');
  visit('preload.cjs');
  const missing = [...seen].filter((f) => !files.has(f));
  assert.deepStrictEqual(missing, []);
});
