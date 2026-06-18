'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { slotRect, COLUMNS } = require('../src/main/canvas/arrange');
const { CANVAS } = require('../src/shared/config');

const opts = { width: 100, height: 80, gap: 10, columns: 3 };

test('slot 0 sits at the origin', () => {
  assert.deepEqual(slotRect(0, opts), { x: 0, y: 0, width: 100, height: 80 });
});

test('slots fill across a row by column', () => {
  assert.deepEqual(slotRect(1, opts), { x: 110, y: 0, width: 100, height: 80 });
  assert.deepEqual(slotRect(2, opts), { x: 220, y: 0, width: 100, height: 80 });
});

test('slots wrap to the next row after `columns`', () => {
  assert.deepEqual(slotRect(3, opts), { x: 0, y: 90, width: 100, height: 80 });
  assert.deepEqual(slotRect(4, opts), { x: 110, y: 90, width: 100, height: 80 });
});

test('no two of the first nine slots overlap', () => {
  const rects = Array.from({ length: 9 }, (_, i) => slotRect(i, opts));
  const overlaps = (a, b) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      assert.ok(!overlaps(rects[i], rects[j]), `slot ${i} overlaps slot ${j}`);
    }
  }
});

test('defaults come from CANVAS config when no overrides given', () => {
  const r = slotRect(0);
  assert.equal(r.width, CANVAS.DEFAULT_PANE.width);
  assert.equal(r.height, CANVAS.DEFAULT_PANE.height);
});

test('COLUMNS is exported and positive', () => {
  assert.ok(Number.isInteger(COLUMNS) && COLUMNS > 0);
});
