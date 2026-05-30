/**
 * Shared drag-and-drop helpers for the tab grid (Phase F). Imported by both
 * GridStage (in-pane drops) and SeedDropOverlay (first-split drops) so the
 * zone logic is defined exactly once.
 */

export type DropZone = 'left' | 'right' | 'top' | 'bottom';

export function zoneToSplit(zone: DropZone): {
  dir: 'row' | 'col';
  side: 'before' | 'after';
} {
  switch (zone) {
    case 'left':
      return { dir: 'row', side: 'before' };
    case 'right':
      return { dir: 'row', side: 'after' };
    case 'top':
      return { dir: 'col', side: 'before' };
    case 'bottom':
      return { dir: 'col', side: 'after' };
  }
}

/** Pointer position within a pane rect → nearest edge (drop target zone). */
export function pickZone(
  rect: DOMRect,
  clientX: number,
  clientY: number,
): DropZone {
  const px = (clientX - rect.left) / rect.width;
  const py = (clientY - rect.top) / rect.height;
  const left = px;
  const right = 1 - px;
  const top = py;
  const bottom = 1 - py;
  const min = Math.min(left, right, top, bottom);
  if (min === left) return 'left';
  if (min === right) return 'right';
  if (min === top) return 'top';
  return 'bottom';
}
