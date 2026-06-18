'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Camera = require('../src/main/canvas/camera');
const { fitPose } = require('../src/main/canvas/camera');
const { CANVAS } = require('../src/shared/config');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('identity transform (scale 1, no pan)', () => {
  const c = new Camera();
  assert.deepEqual(c.worldToScreen(10, 20), { x: 10, y: 20 });
  assert.deepEqual(c.screenToWorld(10, 20), { x: 10, y: 20 });
});

test('scale and pan apply as screen = world*scale + pan', () => {
  const c = new Camera({ x: 5, y: 7, scale: 2 });
  assert.deepEqual(c.worldToScreen(10, 20), { x: 25, y: 47 });
});

test('screenToWorld is the inverse of worldToScreen', () => {
  const c = new Camera({ x: -13, y: 42, scale: 1.75 });
  const s = c.worldToScreen(123, -45);
  const w = c.screenToWorld(s.x, s.y);
  near(w.x, 123);
  near(w.y, -45);
});

test('worldRectToScreen scales size and translates origin', () => {
  const c = new Camera({ x: 100, y: 50, scale: 0.5 });
  assert.deepEqual(c.worldRectToScreen({ x: 20, y: 40, width: 200, height: 100 }),
    { x: 110, y: 70, width: 100, height: 50 });
});

test('scale is clamped to the usable band on construct', () => {
  assert.equal(new Camera({ scale: 1000 }).scale, CANVAS.MAX_SCALE);
  assert.equal(new Camera({ scale: 0 }).scale, CANVAS.MIN_SCALE);
  assert.equal(new Camera({ scale: -5 }).scale, CANVAS.MIN_SCALE);
});

test('zoomTo keeps the world point under the screen anchor fixed', () => {
  const c = new Camera({ x: 30, y: -10, scale: 1.2 });
  const anchor = { x: 640, y: 360 };
  const worldUnder = c.screenToWorld(anchor.x, anchor.y);
  c.zoomTo(2.5, anchor.x, anchor.y);
  near(c.scale, 2.5);
  const after = c.worldToScreen(worldUnder.x, worldUnder.y);
  near(after.x, anchor.x, 1e-6);
  near(after.y, anchor.y, 1e-6);
});

test('zoomBy multiplies the scale about the anchor', () => {
  const c = new Camera({ scale: 1 });
  c.zoomBy(2, 0, 0);
  near(c.scale, 2);
  c.zoomBy(0.5, 0, 0);
  near(c.scale, 1);
});

test('zoomTo clamps but still pins the anchor at the clamped scale', () => {
  const c = new Camera({ scale: 1 });
  const anchor = { x: 200, y: 150 };
  const worldUnder = c.screenToWorld(anchor.x, anchor.y);
  c.zoomTo(999, anchor.x, anchor.y);
  assert.equal(c.scale, CANVAS.MAX_SCALE);
  const after = c.worldToScreen(worldUnder.x, worldUnder.y);
  near(after.x, anchor.x, 1e-6);
  near(after.y, anchor.y, 1e-6);
});

test('panBy shifts the pan offset', () => {
  const c = new Camera({ x: 10, y: 10, scale: 1 });
  c.panBy(5, -3);
  assert.equal(c.x, 15);
  assert.equal(c.y, 7);
  assert.deepEqual(c.worldToScreen(0, 0), { x: 15, y: 7 });
});

test('toJSON round-trips through the constructor', () => {
  const c = new Camera({ x: 12, y: 34, scale: 1.5 });
  const c2 = new Camera(c.toJSON());
  assert.deepEqual(c2.toJSON(), { x: 12, y: 34, scale: 1.5 });
});

test('set() jumps to a pose and clamps the scale', () => {
  const c = new Camera();
  c.set({ x: 5, y: 6, scale: 999 });
  assert.equal(c.x, 5);
  assert.equal(c.y, 6);
  assert.equal(c.scale, CANVAS.MAX_SCALE);
});

test('fitPose with no rects is identity', () => {
  assert.deepEqual(fitPose([], { width: 800, height: 600 }), { x: 0, y: 0, scale: 1 });
});

test('fitPose centers a single rect and fits it under the scale cap', () => {
  // One 100×100 rect in an 800×600 viewport: easily fits, so scale clamps to MAX (4).
  const pose = fitPose([{ x: 0, y: 0, width: 100, height: 100 }], { width: 800, height: 600 },
    { padding: 0, titleH: 0 });
  assert.equal(pose.scale, CANVAS.MAX_SCALE);
  // Center (50,50) → viewport center (400,300): x = 400 - 50*4 = 200; y = 300 - 50*4 = 100.
  near(pose.x, 200);
  near(pose.y, 100);
});

test('fitPose scales down to fit a large spread within padding', () => {
  // Two rects spanning 0..2000 wide; viewport 1000 wide, padding 100 → avail 800 → scale 0.4.
  const rects = [{ x: 0, y: 0, width: 100, height: 100 }, { x: 1900, y: 0, width: 100, height: 100 }];
  const pose = fitPose(rects, { width: 1000, height: 1000 }, { padding: 100, titleH: 0 });
  near(pose.scale, 0.4);
  // bbox is 2000 wide, center x = 1000; mapped to viewport center 500 → x = 500 - 1000*0.4 = 100.
  near(pose.x, 100);
});

test('fitPose never exceeds the scale band', () => {
  const huge = fitPose([{ x: 0, y: 0, width: 1, height: 1 }], { width: 8000, height: 8000 });
  assert.ok(huge.scale <= CANVAS.MAX_SCALE);
  const tiny = fitPose([{ x: 0, y: 0, width: 100000, height: 100000 }], { width: 100, height: 100 });
  assert.ok(tiny.scale >= CANVAS.MIN_SCALE);
});
