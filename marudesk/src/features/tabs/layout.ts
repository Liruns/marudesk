/**
 * Pane layout for the tab grid. A layout is a binary split tree: leaves hold a
 * tab id (the content shown in that pane) and internal nodes split their box
 * into two children — `row` = side by side (vertical divider), `col` = stacked
 * (horizontal divider) — at a `ratio`. Arbitrary grids (2x2, 3x1, 3x3, …) are
 * just nested splits, so there's no fixed "grid size" to special-case.
 *
 * Everything here is pure (no React, no Electron): the store mutates the tree
 * with these helpers, the renderer measures cell rects with `computeRects`, and
 * the main process positions one WebContentsView per leaf using those rects.
 * Pure + serializable so it's trivially unit-testable and snapshot-friendly.
 */

export type Rect = { x: number; y: number; width: number; height: number };
export type PaneId = string;

/** 'row' = panes side by side (a | b); 'col' = stacked (a above b). */
export type SplitDir = 'row' | 'col';

export type LeafNode = {
  type: 'leaf';
  id: PaneId;
  /** The tab shown in this pane, or null for an empty pane. */
  tabId: string | null;
};

export type SplitNode = {
  type: 'split';
  id: PaneId;
  dir: SplitDir;
  /** Fraction of the split's main-axis size given to child `a` (0.1–0.9). */
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
};

export type LayoutNode = LeafNode | SplitNode;

const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

let idSeq = 0;
function nextId(prefix: 'pane' | 'split'): PaneId {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

export function leafLayout(tabId: string | null): LeafNode {
  return { type: 'leaf', id: nextId('pane'), tabId };
}

/** All leaves, left-to-right / top-to-bottom (tree order). */
export function leaves(node: LayoutNode): LeafNode[] {
  return node.type === 'leaf'
    ? [node]
    : [...leaves(node.a), ...leaves(node.b)];
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/**
 * Map each leaf id to its pixel rect within `rect`. Cells abut (no gap); the
 * dividers are drawn as a thin overlay on the seam (tmux-style), so the content
 * views tile the whole area.
 */
export function computeRects(
  node: LayoutNode,
  rect: Rect,
  out: Map<PaneId, Rect> = new Map(),
): Map<PaneId, Rect> {
  if (node.type === 'leaf') {
    out.set(node.id, rect);
    return out;
  }
  if (node.dir === 'row') {
    const aw = Math.round(rect.width * node.ratio);
    computeRects(node.a, { ...rect, width: aw }, out);
    computeRects(
      node.b,
      { x: rect.x + aw, y: rect.y, width: rect.width - aw, height: rect.height },
      out,
    );
  } else {
    const ah = Math.round(rect.height * node.ratio);
    computeRects(node.a, { ...rect, height: ah }, out);
    computeRects(
      node.b,
      { x: rect.x, y: rect.y + ah, width: rect.width, height: rect.height - ah },
      out,
    );
  }
  return out;
}

/**
 * Split the leaf `leafId` into two, placing a new leaf (for `newTabId`) beside
 * it. `side` decides which side the new pane lands on; `dir` the orientation.
 * No-op (returns the tree unchanged) if the leaf isn't found.
 */
export function splitLeaf(
  root: LayoutNode,
  leafId: PaneId,
  dir: SplitDir,
  newTabId: string | null,
  side: 'before' | 'after' = 'after',
): LayoutNode {
  const rec = (n: LayoutNode): LayoutNode => {
    if (n.type === 'leaf') {
      if (n.id !== leafId) return n;
      const fresh = leafLayout(newTabId);
      return {
        type: 'split',
        id: nextId('split'),
        dir,
        ratio: 0.5,
        a: side === 'before' ? fresh : n,
        b: side === 'before' ? n : fresh,
      };
    }
    return { ...n, a: rec(n.a), b: rec(n.b) };
  };
  return rec(root);
}

/** Remove a leaf, collapsing its parent split into the surviving sibling. */
export function removeLeaf(root: LayoutNode, leafId: PaneId): LayoutNode {
  const rec = (n: LayoutNode): LayoutNode | null => {
    if (n.type === 'leaf') return n.id === leafId ? null : n;
    const a = rec(n.a);
    const b = rec(n.b);
    if (a && b) return { ...n, a, b };
    return a ?? b;
  };
  // Never return an empty tree — fall back to a single empty pane.
  return rec(root) ?? leafLayout(null);
}

/** Set a split node's ratio (clamped). No-op if the split isn't found. */
export function setRatio(
  root: LayoutNode,
  splitId: PaneId,
  ratio: number,
): LayoutNode {
  const rec = (n: LayoutNode): LayoutNode => {
    if (n.type === 'leaf') return n;
    if (n.id === splitId) return { ...n, ratio: clampRatio(ratio) };
    return { ...n, a: rec(n.a), b: rec(n.b) };
  };
  return rec(root);
}

/** Bind a tab to a leaf (e.g. after dropping a tab onto a pane). */
export function setLeafTab(
  root: LayoutNode,
  leafId: PaneId,
  tabId: string | null,
): LayoutNode {
  const rec = (n: LayoutNode): LayoutNode => {
    if (n.type === 'leaf') return n.id === leafId ? { ...n, tabId } : n;
    return { ...n, a: rec(n.a), b: rec(n.b) };
  };
  return rec(root);
}
