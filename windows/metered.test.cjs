'use strict';
// ALLOWANCE-ARCH-001 (owner, 2026-11-20): "the allowance shouldn't apply on wifi". On Windows the question is put
// to Windows itself: a connection it marks as metered (a phone hotspot, a data-capped link) is metered; anything
// else, and anything it cannot tell, is not.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCost, createMetered } = require('./metered.cjs');

test('reads what Windows says about the connection', () => {
  assert.equal(parseCost('Unrestricted|False|False\r\n'), false);
  assert.equal(parseCost('Fixed|False|False'), true);
  assert.equal(parseCost('Variable|False|False'), true);
  assert.equal(parseCost('Unrestricted|True|False'), true); // roaming
  assert.equal(parseCost('Unrestricted|False|True'), true); // over its data limit
  assert.equal(parseCost('Unknown|False|False'), null);
  assert.equal(parseCost('none'), null);
  assert.equal(parseCost(''), null);
  assert.equal(parseCost('garbage that is not an answer'), null);
});

test('unknown counts as not metered; the answer is kept and asked again only after a minute', async () => {
  const answers = ['Fixed|False|False', 'Unrestricted|False|False'];
  let asked = 0;
  let now = 1_000_000;
  const m = createMetered({ ask: async () => { asked++; return answers.shift(); }, clock: () => now });
  assert.equal(m.current(), false); // nothing known yet: a desktop is not metered
  await m.settled();
  assert.equal(m.current(), true);
  assert.equal(asked, 1);
  now += 30_000;
  m.current();
  await m.settled();
  assert.equal(asked, 1);
  now += 31_000;
  m.current();
  await m.settled();
  assert.equal(asked, 2);
  assert.equal(m.current(), false);
});

test('a failed question keeps the last answer', async () => {
  let fail = false;
  let now = 0;
  const m = createMetered({ ask: async () => { if (fail) throw new Error('powershell missing'); return 'Variable|False|False'; }, clock: () => now });
  m.current();
  await m.settled();
  fail = true;
  now += 120_000;
  m.current();
  await m.settled();
  assert.equal(m.current(), true);
});
