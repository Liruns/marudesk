'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Camera = require('../src/main/canvas/camera');
const CanvasLayout = require('../src/main/canvas/canvas-layout');

// A region right of a 0px rail, below the 88px chrome (the shape PaneWindow.layout hands a strategy).
const REGION = { left: 0, top: 87, width: 1000, height: 600, regionH: 600 };

const makePane = (world) => {
  const calls = [];
  return { world, last: null, setBounds(r) { this.last = r; calls.push(r); }, calls };
};

const layoutWith = (camera, panes) => new CanvasLayout({ camera, getPanes: () => panes });

test('place() sets bounds for every pane', () => {
  const panes = [makePane({ x: 0, y: 0, width: 100, height: 100 }),
                 makePane({ x: 200, y: 0, width: 100, height: 100 })];
  layoutWith(new Camera(), panes).place(REGION);
  assert.equal(panes[0].calls.length, 1);
  assert.equal(panes[1].calls.length, 1);
});

test('a pane fully inside the region maps to region-offset integer bounds', () => {
  const layout = layoutWith(new Camera(), []);
  // world (10,20) 300×200 at scale 1, region top=87 → screen (10, 107) 300×200.
  const r = layout.screenRectFor({ x: 10, y: 20, width: 300, height: 200 }, REGION);
  assert.deepEqual(r, { x: 10, y: 107, width: 300, height: 200 });
});

test('rects are integer-rounded (native setBounds takes pixels)', () => {
  const layout = layoutWith(new Camera({ scale: 1 / 3 }), []);
  const r = layout.screenRectFor({ x: 1, y: 1, width: 100, height: 100 }, REGION);
  assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y));
  assert.ok(Number.isInteger(r.width) && Number.isInteger(r.height));
});

test('a pane fully outside the region collapses to zero size', () => {
  const layout = layoutWith(new Camera(), []);
  // world x = -5000 → far left of the region, no overlap.
  const r = layout.screenRectFor({ x: -5000, y: 0, width: 100, height: 100 }, REGION);
  assert.deepEqual(r, { x: REGION.left, y: REGION.top, width: 0, height: 0 });
});

test('a pane partly off the left/top edge is clamped to the region', () => {
  const layout = layoutWith(new Camera(), []);
  // world (-50,-50) 200×200 at scale 1, region (left 0, top 87) → abs rect (-50, 37) 200×200.
  // Clamp: x 0, y 87; width 150 (50 spilled off the left), height 150 (50 spilled above the top).
  const r = layout.screenRectFor({ x: -50, y: -50, width: 200, height: 200 }, REGION);
  assert.deepEqual(r, { x: 0, y: 87, width: 150, height: 150 });
});

test('clamping math: a pane straddling the top edge keeps only the visible slice', () => {
  const layout = layoutWith(new Camera(), []);
  // world y=-50 at scale 1, region top=87 → screen top = 87 + (-50) = 37; clamp to 87.
  // pane bottom = 37 + 200 = 237 → visible height = 237 - 87 = 150.
  const r = layout.screenRectFor({ x: 100, y: -50, width: 200, height: 200 }, REGION);
  assert.equal(r.y, 87);
  assert.equal(r.height, 150);
});

test('camera pan/zoom flow through to the placed rect', () => {
  // scale 2, pan (100, 0): world (0,0) 50×50 → screen (100,0) 100×100; region top=87 → y 87.
  const layout = layoutWith(new Camera({ x: 100, y: 0, scale: 2 }), []);
  const r = layout.screenRectFor({ x: 0, y: 0, width: 50, height: 50 }, REGION);
  assert.deepEqual(r, { x: 100, y: 87, width: 100, height: 100 });
});

test('place() routes the same rects screenRectFor computes', () => {
  const camera = new Camera({ x: 10, y: 20, scale: 1.5 });
  const pane = makePane({ x: 4, y: 8, width: 120, height: 90 });
  const layout = layoutWith(camera, [pane]);
  layout.place(REGION);
  assert.deepEqual(pane.last, layout.screenRectFor(pane.world, REGION));
});
