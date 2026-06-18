'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resizeWorld } = require('../src/main/canvas/resize');

const MIN = { width: 240, height: 180 };
const base = { x: 100, y: 100, width: 800, height: 600 };

test('east edge grows width, x unchanged', () => {
  assert.deepEqual(resizeWorld(base, 'e', 50, 0, MIN), { x: 100, y: 100, width: 850, height: 600 });
});

test('south edge grows height, y unchanged', () => {
  assert.deepEqual(resizeWorld(base, 's', 0, 40, MIN), { x: 100, y: 100, width: 800, height: 640 });
});

test('west edge moves x and shrinks width, right edge fixed', () => {
  const r = resizeWorld(base, 'w', 60, 0, MIN);
  assert.equal(r.x, 160);
  assert.equal(r.width, 740);
  assert.equal(r.x + r.width, base.x + base.width); // right edge held
});

test('north edge moves y and shrinks height, bottom edge fixed', () => {
  const r = resizeWorld(base, 'n', 0, 60, MIN);
  assert.equal(r.y, 160);
  assert.equal(r.height, 540);
  assert.equal(r.y + r.height, base.y + base.height); // bottom edge held
});

test('se corner grows both dimensions', () => {
  assert.deepEqual(resizeWorld(base, 'se', 30, 20, MIN), { x: 100, y: 100, width: 830, height: 620 });
});

test('east edge floors at min width', () => {
  const r = resizeWorld(base, 'e', -1000, 0, MIN);
  assert.equal(r.width, MIN.width);
  assert.equal(r.x, 100); // east drag never moves x
});

test('west edge clamps so the right edge stays put at min width', () => {
  const r = resizeWorld(base, 'w', 1000, 0, MIN); // drag left edge far right → would invert
  assert.equal(r.width, MIN.width);
  assert.equal(r.x + r.width, base.x + base.width); // right edge held even at the floor
});

test('north edge clamps so the bottom edge stays put at min height', () => {
  const r = resizeWorld(base, 'n', 0, 1000, MIN);
  assert.equal(r.height, MIN.height);
  assert.equal(r.y + r.height, base.y + base.height);
});

test('nw corner clamps both axes keeping the se corner fixed', () => {
  const r = resizeWorld(base, 'nw', 1000, 1000, MIN);
  assert.equal(r.width, MIN.width);
  assert.equal(r.height, MIN.height);
  assert.equal(r.x + r.width, base.x + base.width);
  assert.equal(r.y + r.height, base.y + base.height);
});
