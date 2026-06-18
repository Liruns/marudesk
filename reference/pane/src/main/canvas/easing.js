'use strict';

/**
 * Easing curves for the canvas's main-process animations (CANVAS.md). Pure functions on t∈[0,1],
 * unit-tested — shared by the camera tween (fit/reset/focus) and the pane-fling spring so the motion
 * vocabulary stays in one place (DESIGN §15: ease for chrome-ish commands, a spring for gestures).
 */

/** Smooth two-way ease for camera commands (no overshoot). f(0)=0, f(1)=1. */
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Spring-ish ease with a slight overshoot past 1 before settling — the "bounce" for a flung pane
 *  coming to rest (DESIGN §15 gesture motion). f(0)=0, f(1)=1, and f rises above 1 near the end. */
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

module.exports = { easeInOutCubic, easeOutBack };
