import {
  getActive,
  getLastBounds,
  getPaneBounds,
  pushState,
  setActiveTabId,
  setLastBounds,
  setPaneBounds,
  tabValues,
  type Bounds,
  type TabRecord,
} from './state';

/**
 * Web-view layout engine. Positions the embedded WebContentsViews to track the
 * React layout: a single active-tab path, plus a grid/pane path (Phase F) when
 * the renderer is tiling several web views at once. The custom DevTools dock is
 * a React sibling of the web stage (the renderer shrinks the web rect for us via
 * browser:set-bounds / devtools:set-dock-bounds), so there is no native dock
 * view to place here.
 */

const OFFSCREEN_BOUNDS: Bounds = { x: -10000, y: -10000, width: 1, height: 1 };

/**
 * Position the embedded web views. In grid mode each web view goes to its pane
 * rect (others hidden); otherwise the single active-tab path runs. The renderer
 * calls this indirectly via set-bounds / set-pane-bounds, and activation/close
 * re-run it so the views always track the React layout.
 */
export function applyWebLayout(): void {
  const paneBounds = getPaneBounds();
  if (paneBounds) {
    applyPaneBounds(paneBounds);
    return;
  }
  applyBoundsToActive();
}

/**
 * Grid layout: show every web tab that has a rect at that rect, and hide every
 * other web tab. Feature tabs own no view, so they're naturally skipped — their
 * React surface paints in the pane instead. (The custom DevTools dock is no-op
 * in grid mode — see the renderer's grid guard — so nothing to place here.)
 */
export function applyPaneBounds(bounds: Map<string, Bounds>): void {
  for (const rec of tabValues()) {
    if (!rec.view) continue;
    // A crashed view stays hidden (its pane goes blank) so it never renders a
    // dead page on top of the stage — see applyBoundsToActive.
    if (rec.crashed) {
      hideTab(rec);
      continue;
    }
    const r = bounds.get(rec.id);
    if (r) {
      rec.view.setVisible(true);
      rec.view.setBounds({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.max(0, Math.round(r.width)),
        height: Math.max(0, Math.round(r.height)),
      });
    } else {
      hideTab(rec);
    }
  }
}

export function applyBoundsToActive(): void {
  const active = getActive();
  if (!active || !active.view) return;
  // A crashed view stays hidden so the renderer's recovery card (painted on the
  // React stage behind it) is visible — the web view otherwise composites on top
  // and would show the dead page. Cleared on reload (did-start-loading).
  if (active.crashed) {
    hideTab(active);
    return;
  }
  // The web rect already excludes the DevTools dock: the renderer measures the
  // web stage (a flex sibling of the React dock) and pushes that rect via
  // browser:set-bounds, so we place the view at exactly the bounds given.
  const b = getLastBounds();
  active.view.setBounds({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  });
}

export function hideTab(rec: TabRecord): void {
  if (!rec.view) return;
  rec.view.setVisible(false);
  rec.view.setBounds({ ...OFFSCREEN_BOUNDS });
}

export function showTab(rec: TabRecord): void {
  // In grid mode the pane layout owns visibility for every web view, so an
  // activation just re-applies the grid (which shows/hides the right set).
  if (getPaneBounds()) {
    applyWebLayout();
    return;
  }
  if (!rec.view) return;
  // Don't reveal a crashed view; the recovery card needs the stage visible.
  if (rec.crashed) {
    hideTab(rec);
    return;
  }
  rec.view.setVisible(true);
  applyBoundsToActive();
}

export function setBrowserBounds(bounds: Bounds): void {
  setLastBounds(bounds);
  applyWebLayout();
}

/**
 * Enter/refresh grid mode: place each listed web view at its pane rect, hide the
 * rest. An empty list means the grid has no web panes (only feature tabs tiled)
 * — still grid mode, so all web views hide. Passing this is how the renderer
 * tells main "the grid is on"; `clearBrowserPaneBounds` turns it back off.
 */
export function setBrowserPaneBounds(
  panes: { tabId: string; rect: Bounds }[],
): void {
  const next = new Map<string, Bounds>();
  for (const p of panes) next.set(p.tabId, p.rect);
  setPaneBounds(next);
  applyPaneBounds(next);
}

/** Leave grid mode and restore the single active-tab view. */
export function clearBrowserPaneBounds(): void {
  if (!getPaneBounds()) return;
  setPaneBounds(null);
  // Hide every web view first so nothing is left stranded.
  for (const rec of tabValues()) hideTab(rec);
  // HIGH-1 defensive: the renderer's activateTab IPC and this clear-pane-bounds
  // IPC may arrive in either order. If activeTabId is already set to the
  // survivor, applyBoundsToActive shows it correctly. If it isn't (the
  // activateTab hasn't been processed yet), fall back to the first live web tab
  // so the stage is never left blank.
  if (getActive()?.view) {
    applyBoundsToActive();
  } else {
    const firstWeb = tabValues().find((r) => r.view);
    if (firstWeb) {
      setActiveTabId(firstWeb.id);
      showTab(firstWeb);
      pushState();
    }
  }
}

export function setBrowserVisible(visible: boolean): void {
  // In grid mode, hide/show all tiled web views together (an overlay covers the
  // whole stage, so a single active view isn't the right unit).
  const paneBounds = getPaneBounds();
  if (paneBounds) {
    if (visible) {
      applyPaneBounds(paneBounds);
    } else {
      for (const rec of tabValues()) {
        if (rec.view) rec.view.setVisible(false);
      }
    }
    return;
  }
  const active = getActive();
  if (!active || !active.view) return;
  // Never reveal a crashed view: the recovery card needs the stage visible, and
  // a transient show (e.g. a SeedDropOverlay unmount calling set-visible true)
  // would otherwise composite the dead page back over the card.
  if (visible && active.crashed) {
    active.view.setVisible(false);
    return;
  }
  active.view.setVisible(visible);
}
