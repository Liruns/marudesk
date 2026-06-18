// The infinite-canvas renderer (DESIGN §11 roadmap — "many Pane instances float and arrange on one
// surface"). Runs in its own WebContentsView (the "canvas view") filling the content region.
//
// Frozen-tile model (CANVAS.md §5): only the ACTIVE pane is a live native view, floating on top of
// this surface at its rect — there we draw chrome (title bar + ring) and leave the interior a hole
// for the live page. Every OTHER pane is a frozen SNAPSHOT this surface renders as a scaled <img>,
// so just one renderer is ever live. Clicking a tile (or its title bar) makes it the live pane.
// Mirrors sidebar.js: same bridge (window.pane), same dom/icons libs, same SAFE_FAVICON guard.
import { $, on } from './lib/dom.js';
import { ICONS } from './lib/icons.js';

// Only let web favicons into this privileged chrome document (no file:/pane:/js: schemes).
const SAFE_FAVICON = /^(?:https?|data):/i;

// HUD-only glyphs not in the shared set. Same 24×24 stroke grammar as lib/icons.js so they don't
// drift from the chrome's icon style; size/color come from CSS (currentColor + width/height).
const hsvg = (inner, w = 2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const GLYPHS = {
  minus: hsvg('<path d="M5 12h14"/>'),
  plus: ICONS.plus,
  // "Fit / frame" — four corner brackets, the standard fit-to-view glyph.
  fit: hsvg('<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>', 1.8),
  // "Target / 100%" — concentric reset-to-origin glyph.
  target: hsvg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/>', 1.8),
};

const TITLE_H = 28; // title-bar height in fixed screen px, drawn ABOVE the page rect
const GRID_STEP = 32; // dot-grid base spacing (region-local px at scale 1); scales with the camera
// Below these screen sizes a tile is too small to read chrome — hide the title bar (keep ring + shot).
const TINY_W = 120;
const TINY_H = 64;
const KEY_PAN_STEP = 60; // arrow-key pan distance per press (screen px)
const HANDLE_HIT = 12; // resize-handle hit size (screen px)
const HANDLE_OUT = 4; // handles sit ~4px OUTSIDE the rect edge, clear of the live native view
// The 8 active-pane resize handles: compass edge → the cursor it shows.
const HANDLES = [
  ['n', 'ns-resize'],
  ['s', 'ns-resize'],
  ['e', 'ew-resize'],
  ['w', 'ew-resize'],
  ['ne', 'nesw-resize'],
  ['sw', 'nesw-resize'],
  ['nw', 'nwse-resize'],
  ['se', 'nwse-resize'],
];

const root = $('#canvas');

// The empty-canvas hint: one quiet caption centered in the surface when there's nothing to navigate
// (exactly one pane, the 'New Tab' start page). Fixed/centered in the viewport — NOT world-anchored —
// and pointer-events:none so it never blocks a pan or the double-click-to-add. Toggled from state.
const hint = document.createElement('div');
hint.className = 'canvas-hint hidden';
hint.textContent = 'Double-click to add a pane.';
root.append(hint);

const els = new Map(); // pane id → { wrap, shot, ring, titleBar, favicon, titleText, img } (diffed across renders)
// Frozen-tile bitmaps (pane id → data: URL). Decoupled from per-frame CANVAS_STATE: snapshots arrive
// on their own onCanvasSnapshot channel only when they change, so the per-frame state stays light.
const shots = new Map();

let state = { on: false, scale: 1, camera: { x: 0, y: 0, scale: 1 }, panes: [] };
let panMoved = false; // set while a pan drag moves, so the trailing click doesn't also raise a tile

// The canvas IS the gesture surface DESIGN §15 reserved spring/inertia for. Pan momentum is real
// physics (friction decay), not a chrome ease — but only when the OS isn't asking to reduce motion.
const motionMQ = matchMedia('(prefers-reduced-motion: reduce)');
let reduceMotion = motionMQ.matches;

// Pan-inertia tuning (§15 momentum). Velocities are px/ms; friction is a per-16ms decay factor,
// framerate-normalized each frame so it feels the same at any refresh rate.
const INERTIA_MIN_START = 0.05; // px/ms — below this on release, the drag just stops (no glide)
const INERTIA_MIN_STOP = 0.02;  // px/ms — the glide ends once it slows past this
const INERTIA_FRICTION = 0.93;  // decay per ~16ms frame
let inertiaRAF = 0; // active inertia rAF id (0 = none)

// Cancel any running pan-momentum glide. Called at the top of every gesture that should interrupt
// it: a new pan/title/handle/minimap pointerdown, a wheel, or any handled keydown.
function cancelInertia() {
  if (inertiaRAF) {
    cancelAnimationFrame(inertiaRAF);
    inertiaRAF = 0;
  }
}

const hud = buildHud(); // bottom-right control cluster — a sibling of #canvas so its clicks don't pan
const minimap = buildMinimap(); // top-right overview navigator — also a sibling of #canvas

window.pane.onCanvasState((s) => {
  state = s || { on: false, scale: 1, camera: { x: 0, y: 0, scale: 1 }, panes: [] };
  if (!state.on) {
    clear();
    hint.classList.add('hidden');
    hud.el.classList.add('hidden');
    minimap.el.classList.add('hidden');
    return;
  }
  hud.el.classList.remove('hidden');
  updateMinimapVisibility();
  updateGrid(state.camera);
  hud.setZoom(state.scale);
  const panes = state.panes || [];
  render(panes);
  // The empty-canvas hint: visible only when the surface is effectively empty — exactly one pane,
  // still the 'New Tab' start page. Any second pane or a renamed pane hides it.
  hint.classList.toggle('hidden', !(panes.length === 1 && panes[0].title === 'New Tab'));
  minimap.update(state);
});

// Frozen-tile bitmaps arrive here (only when they change), not in per-frame CANVAS_STATE. Store the
// dataURL and, if the pane is currently mounted, re-apply its tile so the new bitmap shows at once.
window.pane.onCanvasSnapshot(({ id, snapshot }) => {
  shots.set(id, snapshot);
  const rec = els.get(id);
  if (rec) setShot(rec, rec.pane);
});

// Report the surface's reduced-motion preference to main (it gates motion main-side too), and keep
// it current if the OS setting flips mid-session. reduceMotion also gates pan inertia locally (§15).
window.pane.setCanvasPrefs({ reduceMotion });
on(motionMQ, 'change', (e) => {
  reduceMotion = e.matches;
  if (reduceMotion) cancelInertia();
  window.pane.setCanvasPrefs({ reduceMotion });
});

initCanvasGestures();
initKeyboard();

/* ── Render / diff the pane set ──────────────────────────────────────────────
   Each onCanvasState fires on any camera or pane change, so positions move every frame during a
   pan/zoom. We diff by id (reuse DOM nodes, just reposition) to avoid thrashing the favicon <img>
   and to keep it cheap under continuous camera motion. */
function render(panes) {
  const seen = new Set();

  for (const p of panes) {
    const sc = p.screen;
    // A pane fully off-region arrives clamped to 0×0 — skip it entirely.
    if (!sc || sc.width <= 0 || sc.height <= 0) continue;
    seen.add(p.id);

    let rec = els.get(p.id);
    if (!rec) rec = createPane(p.id);

    position(rec, p, sc);
  }

  // Drop panes that are gone (closed) or fell off-region — also forget any stored snapshot bitmap.
  for (const [id, rec] of els) {
    if (!seen.has(id)) {
      rec.wrap.remove();
      els.delete(id);
      shots.delete(id);
    }
  }
}

function clear() {
  for (const rec of els.values()) rec.wrap.remove();
  els.clear();
  shots.clear();
}

function createPane(id) {
  const wrap = document.createElement('div');
  wrap.className = 'pane';
  wrap.dataset.id = id;

  // The frozen snapshot tile (shown for non-active panes; the active pane is the live view, so its
  // shot is hidden and the page shows through the hole). Scaled to the pane's screen rect.
  const shot = document.createElement('div');
  shot.className = 'pane-shot';

  const ring = document.createElement('div');
  ring.className = 'pane-ring';

  const titleBar = document.createElement('div');
  titleBar.className = 'pane-title';

  const favicon = document.createElement('span');
  favicon.className = 'favicon';

  const titleText = document.createElement('span');
  titleText.className = 'title';

  const close = document.createElement('button');
  close.className = 'close';
  close.setAttribute('aria-label', 'Close pane');
  close.innerHTML = ICONS.close;

  titleBar.append(favicon, titleText, close);
  wrap.append(shot, ring, titleBar);

  // Resize handles — shown only on the ACTIVE pane (CSS hides them otherwise). They live in this DOM,
  // offset OUTWARD from the rect edge so their hit area sits clear of the live native view interior.
  const handles = {};
  for (const [edge, cursor] of HANDLES) {
    const h = document.createElement('div');
    h.className = `pane-handle h-${edge}`;
    h.style.cursor = cursor;
    initHandleDrag(h, id, edge);
    handles[edge] = h;
    wrap.append(h);
  }

  root.append(wrap);

  const rec = { wrap, shot, ring, titleBar, favicon, titleText, handles, img: null, favKey: null, shotKey: null, pane: null };

  // Title-bar click raises/focuses the pane (DESIGN: blue marks the active one).
  on(titleBar, 'click', () => window.pane.canvasRaisePane(id));
  // Clicking a frozen tile's body raises it too — but only a clean click, not the tail of a pan drag.
  on(shot, 'click', () => { if (!panMoved) window.pane.canvasRaisePane(id); });
  // Close button — stop the raise click from also firing.
  on(close, 'click', (e) => { e.stopPropagation(); window.pane.closeTab(id); });
  // Title-bar pointer-drag moves the pane (screen-delta per move).
  initTitleDrag(titleBar, id);

  els.set(id, rec);
  return rec;
}

// Position the chrome from the region-local PAGE rect: ring overlays the rect, title bar sits
// directly above it ([x, y - TITLE_H], width × TITLE_H), and the snapshot tile (non-active panes)
// fills the rect.
function position(rec, p, sc) {
  rec.pane = p; // remember the latest pane object so an out-of-band snapshot can re-run setShot
  rec.wrap.classList.toggle('active', !!p.active);
  rec.wrap.classList.toggle('loading', !!p.loading);
  // Zoomed far out, a tile is too small to read chrome — hide its title bar (keep ring + shot).
  rec.wrap.classList.toggle('tiny', sc.width < TINY_W || sc.height < TINY_H);

  rec.titleBar.style.left = `${sc.x}px`;
  rec.titleBar.style.top = `${sc.y - TITLE_H}px`;
  rec.titleBar.style.width = `${sc.width}px`;

  rec.ring.style.left = `${sc.x}px`;
  rec.ring.style.top = `${sc.y}px`;
  rec.ring.style.width = `${sc.width}px`;
  rec.ring.style.height = `${sc.height}px`;

  // The frozen tile: shown for non-active panes (the active pane is the live native view → no tile).
  rec.shot.style.left = `${sc.x}px`;
  rec.shot.style.top = `${sc.y}px`;
  rec.shot.style.width = `${sc.width}px`;
  rec.shot.style.height = `${sc.height}px`;
  setShot(rec, p);

  // Resize handles (active pane only; CSS hides them otherwise). Place each around the rect, offset
  // ~HANDLE_OUT px OUTWARD so the clickable area sits outside the live native view. Edge handles are
  // centered on each side; corner handles sit at the rect corners. positionHandles is cheap, so it
  // runs every frame alongside the rest of the chrome.
  if (p.active) positionHandles(rec.handles, sc);

  const label = p.title || 'New Tab';
  if (rec.titleText.textContent !== label) rec.titleText.textContent = label;
  rec.titleBar.title = label;

  setFavicon(rec, p.favicon);
}

// Lay the 8 handles around the rect. Each is HANDLE_HIT px; edge midpoints and corners are nudged
// HANDLE_OUT px outward so the hit area clears the live native view. Coordinates are region-local px.
function positionHandles(handles, sc) {
  const hh = HANDLE_HIT;
  const half = hh / 2;
  const left = sc.x;
  const right = sc.x + sc.width;
  const top = sc.y;
  const bottom = sc.y + sc.height;
  const cx = sc.x + sc.width / 2;
  const cy = sc.y + sc.height / 2;
  // Outer edge lines (the strip just outside the rect) and centered corner points.
  const outL = left - HANDLE_OUT - hh;
  const outR = right + HANDLE_OUT;
  const outT = top - HANDLE_OUT - hh;
  const outB = bottom + HANDLE_OUT;
  const pos = {
    n: [cx - half, outT],
    s: [cx - half, outB],
    w: [outL, cy - half],
    e: [outR, cy - half],
    nw: [outL, outT],
    ne: [outR, outT],
    sw: [outL, outB],
    se: [outR, outB],
  };
  for (const edge in pos) {
    const h = handles[edge];
    if (!h) continue;
    h.style.left = `${pos[edge][0]}px`;
    h.style.top = `${pos[edge][1]}px`;
  }
}

// Paint the frozen snapshot as a background-image (cheap to scale). The bitmap is looked up from the
// `shots` map (it arrives out-of-band on onCanvasSnapshot, not in p). Active pane → no tile (hole for
// the live view); a pane with no snapshot yet → an empty placeholder (the ring + title still mark it).
function setShot(rec, p) {
  if (!p) return;
  const shot = shots.get(p.id) || null;
  const key = !p.active && shot ? shot : null;
  if (rec.shotKey !== key) {
    rec.shotKey = key;
    rec.shot.style.backgroundImage = key ? `url("${key}")` : 'none';
  }
  rec.shot.classList.toggle('hidden', !!p.active);
  rec.shot.classList.toggle('empty', !p.active && !shot);
}

function setFavicon(rec, favicon) {
  const key = favicon && SAFE_FAVICON.test(favicon) ? favicon : null;
  if (rec.favKey === key) return; // unchanged — don't reload the image
  rec.favKey = key;

  if (key) {
    if (!rec.img) {
      rec.img = document.createElement('img');
      rec.img.onerror = () => { rec.favKey = null; rec.img = null; rec.favicon.innerHTML = ICONS.globe; };
    }
    rec.img.src = key;
    rec.favicon.replaceChildren(rec.img);
  } else {
    rec.img = null;
    rec.favicon.innerHTML = ICONS.globe;
  }
}

/* ── Title-bar drag: move a pane ─────────────────────────────────────────────
   Pointer events + capture; track the previous pointer position and send screen-deltas. A drag
   suppresses the click-to-raise that would otherwise fire on pointerup. */
function initTitleDrag(titleBar, id) {
  let dragging = false;
  let moved = false;
  let px = 0;
  let py = 0;
  // Release-velocity tracking for the fling, mirroring the canvas-pan inertia. vx/vy are EMA-smoothed
  // px/ms; lastT is the last pointermove timestamp so we divide each delta by the real frame gap.
  let vx = 0;
  let vy = 0;
  let lastT = 0;

  on(titleBar, 'pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.close')) return; // the close button isn't a drag handle
    cancelInertia(); // grabbing a pane interrupts any camera glide
    dragging = true;
    moved = false;
    px = e.clientX;
    py = e.clientY;
    vx = 0;
    vy = 0;
    lastT = e.timeStamp;
    titleBar.classList.add('dragging');
    titleBar.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  on(titleBar, 'pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - px;
    const dy = e.clientY - py;
    if (dx === 0 && dy === 0) return;
    px = e.clientX;
    py = e.clientY;
    moved = true;
    // Track velocity (px/ms), lightly EMA-smoothed so a single jittery sample can't fling the settle.
    const dt = e.timeStamp - lastT;
    lastT = e.timeStamp;
    if (dt > 0) {
      vx = 0.7 * vx + 0.3 * (dx / dt);
      vy = 0.7 * vy + 0.3 * (dy / dt);
    }
    window.pane.canvasPaneMove(id, dx, dy);
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    titleBar.classList.remove('dragging');
    try { titleBar.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    // Fling the pane on release: the §15 gesture spring (main runs the settle). Only when the drag
    // moved, the OS isn't reducing motion, and the throw was fast enough to read as intentional.
    // Skip the round-trip entirely under reduced motion (main applies the same gate).
    if (moved && !reduceMotion && Math.hypot(vx, vy) > 0.05) window.pane.canvasPaneFling(id, vx, vy);
  };
  on(titleBar, 'pointerup', end);
  on(titleBar, 'pointercancel', end);

  // Swallow the synthetic click that follows a real drag so it doesn't also raise the pane.
  on(titleBar, 'click', (e) => { if (moved) { e.stopImmediatePropagation(); moved = false; } }, true);
}

/* ── Resize-handle drag: resize the active pane ──────────────────────────────
   Same prev-pointer / capture pattern as initTitleDrag, but sends edge-tagged screen deltas. On
   pointerdown we stop propagation + preventDefault so it neither starts a canvas pan nor a title
   drag, then capture the pointer and mark the handle .dragging. */
function initHandleDrag(handle, id, edge) {
  let dragging = false;
  let px = 0;
  let py = 0;

  on(handle, 'pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // don't let the canvas pan logic see this
    e.preventDefault();
    cancelInertia(); // a resize interrupts any camera glide
    dragging = true;
    px = e.clientX;
    py = e.clientY;
    handle.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });

  on(handle, 'pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - px;
    const dy = e.clientY - py;
    if (dx === 0 && dy === 0) return;
    px = e.clientX;
    py = e.clientY;
    window.pane.canvasPaneResize(id, edge, dx, dy);
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  on(handle, 'pointerup', end);
  on(handle, 'pointercancel', end);
}

/* ── Canvas gestures: pan, zoom, new pane ────────────────────────────────────
   Empty-area drag (or middle-mouse drag anywhere) pans the camera; wheel zooms about the cursor;
   double-click on empty space opens a new pane. */
function initCanvasGestures() {
  let panning = false;
  let captured = false;
  let px = 0;
  let py = 0;
  // Velocity tracking for the release glide (§15). vx/vy are EMA-smoothed px/ms; lastT is the last
  // pointermove timestamp so we can divide the delta by the real frame gap.
  let vx = 0;
  let vy = 0;
  let lastT = 0;

  on(root, 'pointerdown', (e) => {
    // Left-drag pans from empty space or a frozen tile body; middle-mouse pans from anywhere. Never
    // start a pan from the title bar (that's the move handle). Capture is deferred to the first real
    // move so a clean click still reaches the tile (→ raise).
    const onTitle = e.target.closest('.pane-title');
    const start = (e.button === 1) || (e.button === 0 && !onTitle);
    if (!start) return;
    cancelInertia(); // a fresh grab stops any glide in flight
    panning = true;
    captured = false;
    panMoved = false;
    px = e.clientX;
    py = e.clientY;
    vx = 0;
    vy = 0;
    lastT = e.timeStamp;
  });

  on(root, 'pointermove', (e) => {
    if (!panning) return;
    const dx = e.clientX - px;
    const dy = e.clientY - py;
    if (dx === 0 && dy === 0) return;
    px = e.clientX;
    py = e.clientY;
    panMoved = true;
    // Track velocity (px/ms), lightly EMA-smoothed so a single jittery sample can't fling the glide.
    const dt = e.timeStamp - lastT;
    lastT = e.timeStamp;
    if (dt > 0) {
      vx = 0.7 * vx + 0.3 * (dx / dt);
      vy = 0.7 * vy + 0.3 * (dy / dt);
    }
    if (!captured) { captured = true; root.classList.add('panning'); try { root.setPointerCapture(e.pointerId); } catch { /* unsupported */ } }
    window.pane.canvasPan(dx, dy);
  });

  const end = (e) => {
    if (!panning) return;
    panning = false;
    root.classList.remove('panning');
    if (captured) { try { root.releasePointerCapture(e.pointerId); } catch { /* already released */ } captured = false; }
    // Fling the camera on release: the §15 momentum gesture. Only when the drag actually moved, the
    // OS isn't reducing motion, and the throw was fast enough to read as intentional.
    if (panMoved && !reduceMotion && Math.hypot(vx, vy) > INERTIA_MIN_START) startInertia(vx, vy);
  };
  on(root, 'pointerup', end);
  on(root, 'pointercancel', end);

  // The momentum glide: each frame, advance the camera by velocity × the real frame gap and decay
  // the velocity by friction (framerate-normalized), stopping once it slows past INERTIA_MIN_STOP.
  function startInertia(ivx, ivy) {
    cancelInertia();
    let gvx = ivx;
    let gvy = ivy;
    let prev = performance.now();
    const step = (now) => {
      const dtFrame = now - prev;
      prev = now;
      window.pane.canvasPan(gvx * dtFrame, gvy * dtFrame);
      // Normalize the per-16ms friction to this frame's actual duration.
      const decay = Math.pow(INERTIA_FRICTION, dtFrame / 16);
      gvx *= decay;
      gvy *= decay;
      if (Math.hypot(gvx, gvy) < INERTIA_MIN_STOP) { inertiaRAF = 0; return; }
      inertiaRAF = requestAnimationFrame(step);
    };
    inertiaRAF = requestAnimationFrame(step);
  }

  // Plain wheel PANS the camera; Ctrl/Cmd+wheel ZOOMS about the cursor (region-local offset).
  // Steady factor — felt, not faked. Always preventDefault so the page never scrolls.
  on(root, 'wheel', (e) => {
    e.preventDefault();
    cancelInertia(); // a wheel intent interrupts a glide
    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      window.pane.canvasZoom(factor, e.offsetX, e.offsetY);
    } else {
      window.pane.canvasPan(-e.deltaX, -e.deltaY);
    }
  }, { passive: false });

  // Double-click a pane (tile or title bar) → focus it (animated zoom). Empty space → new pane.
  on(root, 'dblclick', (e) => {
    const pane = e.target.closest('.pane');
    if (pane) {
      window.pane.canvasFocusPane(pane.dataset.id);
    } else {
      window.pane.newTab();
    }
  });
}

/* ── Minimap visibility ───────────────────────────────────────────────────────
   The minimap shows only when canvas mode is on AND the viewport region is large enough to be worth
   a navigator — on a small region it would crowd the page, so it auto-hides (the bottom-right zoom
   HUD stays). The region comes from CANVAS_STATE; thresholds below the responsive floor (DESIGN §8). */
const MINIMAP_MIN_W = 480;
const MINIMAP_MIN_H = 360;
function updateMinimapVisibility() {
  const region = state.region || { width: 0, height: 0 };
  const tooSmall = region.width < MINIMAP_MIN_W || region.height < MINIMAP_MIN_H;
  minimap.el.classList.toggle('hidden', !state.on || tooSmall);
}

/* ── Dot-grid background ──────────────────────────────────────────────────────
   A faint radial-dot pattern on #canvas that pans and scales WITH the camera, conveying the
   infinite pannable surface (DESIGN deference — low-contrast, never competes with the page). The
   tile size = GRID_STEP × camera.scale and the origin = the camera's region-local pan offset. */
function updateGrid(camera) {
  const cam = camera || { x: 0, y: 0, scale: state.scale || 1 };
  const step = GRID_STEP * (cam.scale || 1);
  root.style.backgroundSize = `${step}px ${step}px`;
  root.style.backgroundPosition = `${cam.x || 0}px ${cam.y || 0}px`;
}

/* ── Canvas HUD: bottom-right zoom / fit / reset / exit cluster ───────────────
   A sibling of #canvas (appended to <body>), so clicks land on the HUD rather than starting a pan.
   Position: fixed bottom-right → stays cornered on resize. DESIGN §4 icon-button grammar. */
function buildHud() {
  const cx = () => window.innerWidth / 2;
  const cy = () => window.innerHeight / 2;

  const el = document.createElement('div');
  el.className = 'canvas-hud hidden'; // revealed by onCanvasState once canvas mode is on

  const btn = (label, html, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = `hud-btn${cls ? ' ' + cls : ''}`;
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = html;
    on(b, 'click', fn);
    return b;
  };

  const sep = () => {
    const s = document.createElement('span');
    s.className = 'hud-sep';
    return s;
  };

  const zoomOut = btn('Zoom out', GLYPHS.minus, () => window.pane.canvasZoom(1 / 1.1, cx(), cy()));
  const zoomLabel = document.createElement('button');
  zoomLabel.className = 'hud-zoom';
  zoomLabel.type = 'button';
  zoomLabel.title = 'Reset zoom';
  zoomLabel.setAttribute('aria-label', 'Reset zoom to 100%');
  on(zoomLabel, 'click', () => window.pane.canvasReset());
  const zoomIn = btn('Zoom in', GLYPHS.plus, () => window.pane.canvasZoom(1.1, cx(), cy()));

  const fit = btn('Fit all', GLYPHS.fit, () => window.pane.canvasFit());
  const reset = btn('Reset zoom', GLYPHS.target, () => window.pane.canvasReset());
  const exit = btn('Exit canvas', ICONS.close, () => window.pane.setCanvasMode(false));

  el.append(zoomOut, zoomLabel, zoomIn, sep(), fit, reset, exit);
  document.body.append(el);

  let lastPct = null;
  const setZoom = (scale) => {
    const pct = Math.round((scale || 1) * 100);
    if (pct === lastPct) return; // avoid thrashing text every camera frame
    lastPct = pct;
    zoomLabel.textContent = `${pct}%`;
  };
  setZoom(state.scale);

  return { el, setZoom };
}

/* ── Minimap: an overview navigator ───────────────────────────────────────────
   A small fixed top-right widget (clear of the bottom-right HUD), same popover grammar as the HUD
   (translucent surface-1, hairline, the one soft elevation, blur). It draws every pane and the
   current viewport as outlined rects fitted into its inner area, and pointer-drag/click on the inner
   area centers the camera on the corresponding world point. A sibling of #canvas so clicks don't pan.
   Built once; .update(state) clears-and-rebuilds the inner rects each frame (few panes → cheap). */
function buildMinimap() {
  const PAD = 6; // inner padding (px) so rects don't touch the widget edge

  const el = document.createElement('div');
  el.className = 'canvas-minimap hidden';

  const inner = document.createElement('div');
  inner.className = 'minimap-inner';
  el.append(inner);
  document.body.append(el);

  // The last fit transform — kept so a pointer interaction can invert local px → world point.
  let fit = null; // { bx, by, mScale, offX, offY }

  const update = (s) => {
    const panes = (s.panes || []).filter((p) => p.world);
    const cam = s.camera || { x: 0, y: 0, scale: s.scale || 1 };
    const region = s.region || { width: 0, height: 0 };
    const scale = cam.scale || 1;

    // No panes (or no usable geometry) → nothing meaningful to navigate; hide the inner rects.
    if (panes.length === 0 || !(scale > 0)) {
      inner.replaceChildren();
      fit = null;
      return;
    }

    // World bounding box = union of every pane.world AND the viewport-in-world rect.
    const vx = -cam.x / scale;
    const vy = -cam.y / scale;
    const vw = region.width / scale;
    const vh = region.height / scale;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const acc = (x, y, w, h) => {
      if (!(w > 0) || !(h > 0)) return;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    };
    for (const p of panes) acc(p.world.x, p.world.y, p.world.width, p.world.height);
    acc(vx, vy, vw, vh);

    const bw = maxX - minX;
    const bh = maxY - minY;
    if (!(bw > 0) || !(bh > 0) || !isFinite(bw) || !isFinite(bh)) {
      inner.replaceChildren();
      fit = null;
      return;
    }

    // Inner drawable area (the widget's content box minus padding).
    const innerW = inner.clientWidth - PAD * 2;
    const innerH = inner.clientHeight - PAD * 2;
    if (!(innerW > 0) || !(innerH > 0)) { fit = null; return; }

    const mScale = Math.min(innerW / bw, innerH / bh);
    // Center the fitted bbox in the inner area.
    const offX = PAD + (innerW - bw * mScale) / 2;
    const offY = PAD + (innerH - bh * mScale) / 2;
    fit = { bx: minX, by: minY, mScale, offX, offY };

    const toLocal = (wx, wy) => [offX + (wx - minX) * mScale, offY + (wy - minY) * mScale];

    const frag = document.createDocumentFragment();
    for (const p of panes) {
      const r = document.createElement('div');
      r.className = `minimap-rect${p.active ? ' active' : ''}`;
      const [lx, ly] = toLocal(p.world.x, p.world.y);
      r.style.left = `${lx}px`;
      r.style.top = `${ly}px`;
      r.style.width = `${Math.max(2, p.world.width * mScale)}px`;
      r.style.height = `${Math.max(2, p.world.height * mScale)}px`;
      frag.append(r);
    }
    // The current viewport, as an outlined (no-fill) rect.
    const vp = document.createElement('div');
    vp.className = 'minimap-viewport';
    const [vlx, vly] = toLocal(vx, vy);
    vp.style.left = `${vlx}px`;
    vp.style.top = `${vly}px`;
    vp.style.width = `${Math.max(2, vw * mScale)}px`;
    vp.style.height = `${Math.max(2, vh * mScale)}px`;
    frag.append(vp);

    inner.replaceChildren(frag);
  };

  // Pointer interaction: click or drag the inner area → invert the fit transform to a world point →
  // center the camera there. stopPropagation so it never starts a canvas pan.
  let dragging = false;
  const navigate = (e) => {
    if (!fit) return;
    const box = inner.getBoundingClientRect();
    const localX = e.clientX - box.left;
    const localY = e.clientY - box.top;
    const wx = fit.bx + (localX - fit.offX) / fit.mScale;
    const wy = fit.by + (localY - fit.offY) / fit.mScale;
    window.pane.canvasCenter(wx, wy);
  };

  on(inner, 'pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    cancelInertia(); // a minimap navigation interrupts any camera glide
    dragging = true;
    inner.setPointerCapture(e.pointerId);
    navigate(e);
  });
  on(inner, 'pointermove', (e) => {
    if (!dragging) return;
    e.stopPropagation();
    navigate(e);
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { inner.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  on(inner, 'pointerup', end);
  on(inner, 'pointercancel', end);

  return { el, update };
}

/* ── Keyboard shortcuts ───────────────────────────────────────────────────────
   Window-level; ignored while typing in an input/textarea/contenteditable. Zoom is about the
   canvas center; arrows pan a fixed step; 0 resets, f fits, Escape leaves canvas mode. */
function initKeyboard() {
  on(window, 'keydown', (e) => {
    if (!state.on) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return; // leave OS / app accelerators alone
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    // Any key we actually act on interrupts a camera glide (§15). Keys that fall through to the
    // default no-op below don't touch the camera, so they leave an in-flight glide alone.
    const HANDLED = new Set(['+', '=', '-', '0', 'f', 'F', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape']);
    if (HANDLED.has(e.key)) cancelInertia();

    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    switch (e.key) {
      case '+':
      case '=':
        e.preventDefault();
        window.pane.canvasZoom(1.1, cx, cy);
        break;
      case '-':
        e.preventDefault();
        window.pane.canvasZoom(1 / 1.1, cx, cy);
        break;
      case '0':
        e.preventDefault();
        window.pane.canvasReset();
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        window.pane.canvasFit();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        window.pane.canvasPan(KEY_PAN_STEP, 0);
        break;
      case 'ArrowRight':
        e.preventDefault();
        window.pane.canvasPan(-KEY_PAN_STEP, 0);
        break;
      case 'ArrowUp':
        e.preventDefault();
        window.pane.canvasPan(0, KEY_PAN_STEP);
        break;
      case 'ArrowDown':
        e.preventDefault();
        window.pane.canvasPan(0, -KEY_PAN_STEP);
        break;
      case 'Escape':
        e.preventDefault();
        window.pane.setCanvasMode(false);
        break;
      default:
        break;
    }
  });
}
