'use strict';

/**
 * Tabs-mode content layout (DESIGN §5) — the first of two layout strategies.
 *
 * PaneWindow.layout() owns the *window-level* math: the chrome band's height and the vertical-tabs
 * rail inset. What's left is the **content region** (everything right of the rail, below the chrome),
 * and *how that region is filled* is a per-mode decision — exactly the seam the infinite canvas needs
 * (CANVAS.md): tabs mode fills it with the one active tab (deferring to the devtools dock for the
 * page │ splitter │ devtools split), while CanvasLayout will later tile many panes from a camera.
 *
 * Keeping the strategy as an object (not a string `mode` switch) means swapping the object swaps the
 * mode — PaneWindow stays closed to the difference. Today only this one exists; it's wired so its
 * behavior is byte-for-byte the old inline code.
 */
class TabLayout {
  /** @param {{ dock: object, getActiveView: () => (object|null) }} deps */
  constructor({ dock, getActiveView }) {
    this._dock = dock;
    this._getActiveView = getActiveView;
  }

  /** Fill `region` ({ left, top, width, regionH }) with the active tab's page, deferring to the
   *  devtools dock when one is docked (page │ splitter │ devtools); otherwise the page fills it. */
  place(region) {
    const view = this._getActiveView();
    if (!view) return;
    const { left, top, width, regionH } = region;
    const page = view.view;
    if (!this._dock.layoutInto(page, { left, top, width, regionH })) {
      page.setBounds({ x: left, y: top, width: width - left, height: regionH });
    }
  }
}

module.exports = TabLayout;
