'use strict';

/**
 * Pane resize math for the canvas (CANVAS.md) — pure geometry, unit-tested.
 *
 * Given a world rect, the dragged edge/corner, and a world-space delta, return the new rect with the
 * opposite edge held fixed and a minimum size enforced. `edge` is a compass string built from any of
 * n/s/e/w (e.g. 'se' = bottom-right corner, 'w' = left edge). Side-effect-free so it's testable
 * without Electron; PaneWindow converts the screen drag delta to world units (÷ camera scale) first.
 */
function resizeWorld(world, edge, dx, dy, min) {
  let { x, y, width, height } = world;
  const right = x + width;
  const bottom = y + height;

  if (edge.includes('e')) width = width + dx;
  if (edge.includes('s')) height = height + dy;
  if (edge.includes('w')) { x = x + dx; width = right - x; }
  if (edge.includes('n')) { y = y + dy; height = bottom - y; }

  // Enforce the minimum, keeping the anchored (opposite) edge fixed: a west/north drag clamps the
  // moving edge so the fixed right/bottom stays put; an east/south drag just floors the size.
  if (width < min.width) {
    if (edge.includes('w')) x = right - min.width;
    width = min.width;
  }
  if (height < min.height) {
    if (edge.includes('n')) y = bottom - min.height;
    height = min.height;
  }
  return { x, y, width, height };
}

module.exports = { resizeWorld };
