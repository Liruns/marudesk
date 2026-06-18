'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { easeInOutCubic, easeOutBack } = require('../src/main/canvas/easing');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('easeInOutCubic pins the endpoints and midpoint', () => {
  near(easeInOutCubic(0), 0);
  near(easeInOutCubic(1), 1);
  near(easeInOutCubic(0.5), 0.5);
});

test('easeInOutCubic is monotonic and bounded in [0,1]', () => {
  let prev = -1;
  for (let i = 0; i <= 20; i++) {
    const v = easeInOutCubic(i / 20);
    assert.ok(v >= prev, 'monotonic non-decreasing');
    assert.ok(v >= -1e-9 && v <= 1 + 1e-9, 'stays within [0,1]');
    prev = v;
  }
});

test('easeOutBack pins the endpoints', () => {
  near(easeOutBack(0), 0);
  near(easeOutBack(1), 1);
});

test('easeOutBack overshoots above 1 before settling (the spring bounce)', () => {
  let maxV = 0;
  for (let i = 0; i <= 100; i++) maxV = Math.max(maxV, easeOutBack(i / 100));
  assert.ok(maxV > 1, `expected an overshoot >1, got peak ${maxV}`);
});
