'use strict';
/**
 * canvas-verify — on-machine verification driver for Pane's infinite-canvas mode (CANVAS.md, DESIGN §11).
 *
 * Launches the real Electron app in an isolated throwaway profile via Playwright `_electron`, drives
 * the canvas through the same PaneWindow methods the IPC handlers call, reads ground truth from the
 * MAIN process, captures the canvas surface (capturePage) + an OS composite (Windows only), asserts
 * the canvas contract, writes a report, and exits non-zero if anything regressed.
 *
 * CANVAS.md flags the canvas input/z-order model as "unverifiable headless" — you cannot prove it with
 * `node --test` or by importing a function. This driver is the on-machine proof. It lives in scripts/
 * (not test/) so the `node --test` suite never launches Electron.
 *
 * Why drive from main, not the page:
 *   The window is an Electron `BaseWindow` hosting several `WebContentsView`s (toolbar, page views,
 *   canvas surface, devtools host). Playwright does NOT report a BaseWindow as a `window`, and the
 *   canvas input/z-order model is flagged unverifiable headless — so we reach into the main process
 *   and call the PaneWindow methods directly, then read the resulting world/camera state back.
 *
 * Gotcha that costs an hour if you miss it:
 *   Inside `app.evaluate(fn, arg)`, Playwright runs `fn(electronModule, arg)` in MAIN, but does NOT
 *   bind this file's module-scope `require`. Reach app modules via `process.mainModule.require(absPath)`
 *   (returns the already-cached singleton). We pass the absolute path to windows.js as the evaluate arg.
 *
 * Session-restore contamination:
 *   The app persists camera pose + world rects to its userData on `before-quit`. Reusing a profile
 *   restores stale state and makes a fresh run look wrong. We wipe the profile dir every run.
 *
 * Usage:   node scripts/canvas-verify.js     (or: npm run verify:canvas)
 * Exit:    0 = all checks passed, no console errors · 1 = a check failed or console errors · 2 = setup error
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const cp = require('node:child_process');

// Repo root, resolved from this file's location: scripts/ -> ..
const APP_DIR = path.resolve(__dirname, '..');
const W_PATH = path.join(APP_DIR, 'src', 'main', 'windows.js').replace(/\\/g, '/'); // require() arg in main

// playwright-core is a dev-only helper for this driver; it is intentionally NOT in package.json deps.
// Install once per machine:  npm install --no-save playwright-core
let _electron;
try {
  ({ _electron } = require(path.join(APP_DIR, 'node_modules', 'playwright-core')));
} catch {
  console.error('[canvas-verify] playwright-core not found. Install it (not saved to package.json):');
  console.error('               npm install --no-save playwright-core');
  process.exit(2);
}
let electronPath;
try {
  electronPath = require(path.join(APP_DIR, 'node_modules', 'electron')); // -> electron.exe path string
} catch {
  console.error('[canvas-verify] electron not found — run `npm install` first.');
  process.exit(2);
}

const OUT = path.join(os.tmpdir(), 'pane-canvas-verify');
const UDD = path.join(OUT, 'udata');
fs.mkdirSync(OUT, { recursive: true });
try { fs.rmSync(UDD, { recursive: true, force: true }); } catch {} // fresh profile each run (no session restore)

const log = (...a) => console.log('[canvas-verify]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const report = { steps: [], checks: [], errors: [], shots: [], ok: false };
  const check = (name, pass, detail) => { report.checks.push({ name, pass: !!pass, detail }); log(pass ? 'PASS' : 'FAIL', name, detail == null ? '' : `(${detail})`); };

  const app = await _electron.launch({
    executablePath: electronPath,
    args: ['.', `--user-data-dir=${UDD}`],
    cwd: APP_DIR,
  });

  // Hook console errors/warnings + crashes on every webContents (existing + future).
  await app.evaluate(({ webContents, app }) => {
    global.__errs = [];
    const hook = (wc) => {
      wc.on('console-message', (...args) => {
        const a0 = args[0];
        let lvl, msg, src, ln;
        if (a0 && typeof a0 === 'object' && 'message' in a0) { lvl = a0.level; msg = a0.message; src = a0.sourceId; ln = a0.lineNumber; }
        else { lvl = args[1]; msg = args[2]; ln = args[3]; src = args[4]; }
        if (lvl === 'error' || lvl === 'warning' || lvl === 3 || lvl === 2)
          global.__errs.push(`[${lvl}] ${String(src || '').split(/[\\/]/).pop()}:${ln} ${msg}`);
      });
      wc.on('render-process-gone', (_e, d) => global.__errs.push(`RENDER-GONE ${JSON.stringify(d)}`));
      wc.on('preload-error', (_e, p, err) => global.__errs.push(`PRELOAD-ERR ${p} ${err && err.message}`));
    };
    webContents.getAllWebContents().forEach(hook);
    app.on('web-contents-created', (_e, wc) => hook(wc));
  });

  const readState = () => app.evaluate((_electron, winPath) => {
    const W = process.mainModule.require(winPath);
    const w = W.focused() || W.all()[0];
    if (!w) return { error: 'no window' };
    const cam = w._camera;
    return {
      mode: w._mode,
      camera: { x: +cam.x.toFixed(2), y: +cam.y.toFixed(2), scale: +cam.scale.toFixed(4) },
      activeId: w.tabs.activeId,
      panes: w.tabs.tabs.map((t) => ({
        id: t.id, title: t.title || 'New Tab', active: t.id === w.tabs.activeId,
        world: t.world ? { x: Math.round(t.world.x), y: Math.round(t.world.y), w: Math.round(t.world.width), h: Math.round(t.world.height) } : null,
      })),
    };
  }, W_PATH);

  const capCanvas = async (name) => {
    const b64 = await app.evaluate(async ({ webContents }) => {
      const cv = webContents.getAllWebContents().find((w) => (w.getURL() || '').includes('canvas.html'));
      if (!cv) return null;
      const img = await cv.capturePage();
      return img.isEmpty() ? null : img.toPNG().toString('base64');
    });
    if (b64) { fs.writeFileSync(path.join(OUT, name), Buffer.from(b64, 'base64')); report.shots.push(name); log('canvas-shot', name); return true; }
    log('canvas-shot EMPTY', name); return false;
  };

  // Full-screen OS composite — Windows only (PowerShell). Skipped elsewhere; capCanvas is the cross-platform proof.
  const osShot = (name) => {
    if (process.platform !== 'win32') return;
    const dst = path.join(OUT, name).replace(/\\/g, '/');
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${dst}'); $g.Dispose(); $bmp.Dispose()`;
    try { cp.execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: 'ignore' }); report.shots.push(name); log('os-shot', name); }
    catch (e) { log('os-shot FAIL', e.message); }
  };

  await sleep(1600);
  const boot = await readState();
  report.steps.push({ step: 'boot', state: boot });
  log('boot', JSON.stringify(boot));
  check('boot in tabs mode', boot.mode === 'tabs', `mode=${boot.mode}`);

  // Ensure 3 tabs.
  await app.evaluate((_electron, winPath) => {
    const W = process.mainModule.require(winPath);
    const w = W.focused() || W.all()[0];
    while (w.tabs.tabs.length < 3) w.tabs.newTab();
  }, W_PATH);
  await sleep(900);
  const three = await readState();
  report.steps.push({ step: 'three-tabs', state: three });
  check('three tabs created', three.panes.length === 3, `panes=${three.panes.length}`);

  // Enter canvas mode.
  await app.evaluate((_electron, winPath) => {
    const W = process.mainModule.require(winPath);
    const w = W.focused() || W.all()[0];
    w.setCanvasMode(true);
  }, W_PATH);
  await sleep(1300);
  const sOn = await readState();
  report.steps.push({ step: 'canvas-on', state: sOn });
  check('entered canvas mode', sOn.mode === 'canvas', `mode=${sOn.mode}`);
  check('panes seeded world rects', sOn.panes.length > 0 && sOn.panes.every((p) => p.world), sOn.panes.map((p) => !!p.world).join(','));

  await app.evaluate((_electron, winPath) => {
    const W = process.mainModule.require(winPath);
    const w = W.focused() || W.all()[0];
    w.win.show(); w.win.focus();
  }, W_PATH);
  await sleep(500);
  await capCanvas('1-canvas-on.png');
  osShot('os-1-canvas-on.png');

  // Pan.
  const bPan = sOn;
  await app.evaluate((_electron, winPath) => {
    const W = process.mainModule.require(winPath);
    const w = W.focused() || W.all()[0];
    w.onCanvasPan(180, 120);
  }, W_PATH);
  await sleep(350);
  const aPan = await readState();
  report.steps.push({ step: 'pan(180,120)', cameraBefore: bPan.camera, cameraAfter: aPan.camera });
  check('pan moved camera', aPan.camera.x !== bPan.camera.x || aPan.camera.y !== bPan.camera.y, `${bPan.camera.x},${bPan.camera.y} -> ${aPan.camera.x},${aPan.camera.y}`);

  // Zoom about viewport center.
  await app.evaluate((_electron, winPath) => {
    const W = process.mainModule.require(winPath);
    const w = W.focused() || W.all()[0];
    let r; try { r = w._region(); } catch { r = { width: 1200, regionH: 760 }; }
    w.onCanvasZoom(1.3, (r.width || 1200) / 2, (r.regionH || 760) / 2);
  }, W_PATH);
  await sleep(350);
  const aZoom = await readState();
  report.steps.push({ step: 'zoom(1.3)', scaleBefore: aPan.camera.scale, scaleAfter: aZoom.camera.scale });
  check('zoom changed scale', aZoom.camera.scale > aPan.camera.scale, `${aPan.camera.scale} -> ${aZoom.camera.scale}`);
  await capCanvas('2-after-pan-zoom.png');
  osShot('os-2-after-pan-zoom.png');

  // Move a non-active pane; capture before/after + scale + every other pane's world IN one evaluate
  // (no inter-call drift), to confirm the screen->world conversion AND that only the target moved.
  const mv = await app.evaluate((_electron, winPath) => {
    const W = process.mainModule.require(winPath);
    const w = W.focused() || W.all()[0];
    const t = w.tabs.tabs.find((x) => !(x.id === w.tabs.activeId) && x.world) || w.tabs.tabs.find((x) => x.world);
    const snap = (o) => o ? { x: Math.round(o.x), y: Math.round(o.y) } : null;
    const others = w.tabs.tabs.filter((x) => x.id !== t.id && x.world).map((x) => ({ id: x.id, w: snap(x.world) }));
    const before = snap(t.world);
    const scale = w._camera.scale;
    w.onCanvasPaneMove(t.id, 220, 80);
    const after = snap(t.world);
    const othersAfter = w.tabs.tabs.filter((x) => x.id !== t.id && x.world).map((x) => ({ id: x.id, w: snap(x.world) }));
    const othersUnchanged = others.every((o) => { const a = othersAfter.find((y) => y.id === o.id); return a && a.w.x === o.w.x && a.w.y === o.w.y; });
    return { id: t.id, scale, before, after, expectDx: Math.round(220 / scale), expectDy: Math.round(80 / scale), othersUnchanged };
  }, W_PATH);
  report.steps.push({ step: 'paneMove(+220,+80 screen px)', ...mv });
  const dx = mv.after.x - mv.before.x, dy = mv.after.y - mv.before.y;
  log('move id', mv.id, `scale=${mv.scale.toFixed(3)}`, JSON.stringify(mv.before), '->', JSON.stringify(mv.after), `expect +(${mv.expectDx},${mv.expectDy})`);
  check('pane-move moved target', dx !== 0 || dy !== 0, `+(${dx},${dy})`);
  check('pane-move screen->world math', Math.abs(dx - mv.expectDx) <= 1 && Math.abs(dy - mv.expectDy) <= 1, `got +(${dx},${dy}) expect +(${mv.expectDx},${mv.expectDy}) @scale ${mv.scale.toFixed(3)}`);
  check('pane-move left others put', mv.othersUnchanged, String(mv.othersUnchanged));

  // Fit-all.
  await app.evaluate((_electron, winPath) => {
    const W = process.mainModule.require(winPath);
    const w = W.focused() || W.all()[0];
    w.fitCanvas();
  }, W_PATH);
  await sleep(800);
  const fit = await readState();
  report.steps.push({ step: 'fit', state: fit });
  check('fit framed all panes (zoomed out)', fit.camera.scale < 1, `scale=${fit.camera.scale}`);
  await capCanvas('3-after-fit.png');
  osShot('os-3-after-fit.png');

  // ── Camera-on-activate (regression gate for the activation chokepoint) ───────────────────────────
  // The command palette / tab strip activate a pane via tabs.activate → active-page → _setActiveView,
  // which MUST frame the pane (a pane must never go live off-screen). Prove it the only honest way:
  // park a chosen pane fully off-screen (precondition), activate it via tabs.activate (NOT
  // focusCanvasPane — that path was never broken), then assert the camera brought it back into view.
  const preAct = await app.evaluate((_electron, winPath) => {
    const W = process.mainModule.require(winPath);
    const w = W.focused() || W.all()[0];
    const target = w.tabs.tabs.find((x) => x.id !== w.tabs.activeId && x.world) || w.tabs.tabs.find((x) => x.world);
    let r; try { r = w._region(); } catch { r = { width: 1200, regionH: 760 }; }
    const sc = w._camera.scale; // shove the camera so the target sits far off the left edge (keep scale)
    w._camera.set({ x: -(target.world.x + target.world.width) * sc - 4000, y: w._camera.y, scale: sc });
    const s = w._camera.worldRectToScreen(target.world);
    const off = (s.x + s.width) <= 0 || s.x >= (r.width || 1200) || (s.y + s.height) <= 0 || s.y >= (r.regionH || 760);
    return { id: target.id, off };
  }, W_PATH);
  check('activate precondition: pane parked off-screen', preAct.off, String(preAct.off));
  await app.evaluate((_electron, [winPath, id]) => {
    const W = process.mainModule.require(winPath);
    const w = W.focused() || W.all()[0];
    w.tabs.activate(id); // the exact path the command palette / tab strip use
  }, [W_PATH, preAct.id]);
  await sleep(700); // let the frame-the-pane camera tween settle
  const postAct = await app.evaluate((_electron, winPath) => {
    const W = process.mainModule.require(winPath);
    const w = W.focused() || W.all()[0];
    const t = w.tabs.tabs.find((x) => x.id === w.tabs.activeId);
    let r; try { r = w._region(); } catch { r = { width: 1200, regionH: 760 }; }
    const s = w._camera.worldRectToScreen(t.world);
    const cx = s.x + s.width / 2, cy = s.y + s.height / 2;
    return { activeId: w.tabs.activeId, centered: cx > 0 && cx < (r.width || 1200) && cy > 0 && cy < (r.regionH || 760) };
  }, W_PATH);
  report.steps.push({ step: 'activate-frames-pane', target: preAct.id, ...postAct });
  check('activate made the target pane active', postAct.activeId === preAct.id, `active=${postAct.activeId}`);
  check('activate framed the off-screen pane back into view', postAct.centered, `centered=${postAct.centered}`);

  report.errors = await app.evaluate(() => global.__errs || []);
  check('no console errors', report.errors.length === 0, report.errors.length ? report.errors.join(' | ') : '0');

  report.ok = report.errors.length === 0 && report.checks.every((c) => c.pass);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  log('===REPORT===', 'ok=', report.ok, '| out:', OUT);
  const failed = report.checks.filter((c) => !c.pass);
  if (failed.length) log('FAILED CHECKS:', failed.map((c) => c.name).join('; '));
  await app.close();
  process.exit(report.ok ? 0 : 1);
})().catch((e) => { console.error('[canvas-verify] FATAL', e && e.stack || e); process.exit(2); });
