import { useEffect, useState, type DragEvent as ReactDragEvent } from 'react';
import { cn } from '../../lib/cn';
import { useGridStore } from './grid';
import { pickZone, zoneToSplit, type DropZone } from './dnd';

// Must match TabStrip's drag MIME.
const TAB_DND_MIME = 'application/x-marudesk-tab';

/**
 * Mounted over the single view only while a tab is dragged from the strip.
 * Dropping the tab here seeds the first 2-pane grid (active tab + dragged tab),
 * split toward the edge the cursor is nearest. Because an active web tab's
 * WebContentsView paints above the React DOM, this overlay hides that view on
 * mount and restores it on unmount, so the drop always lands on React. The
 * overlay is otherwise fully transparent until a tab is dragged over it.
 */
export function SeedDropOverlay({ draggedTabId }: { draggedTabId: string }) {
  const splitWith = useGridStore((s) => s.splitWith);
  const [zone, setZone] = useState<DropZone | null>(null);

  // Hide the embedded web view for the duration of the drag so the overlay
  // receives the drop (the native view would otherwise swallow it). Restored on
  // unmount (drag end), which re-applies the active view's bounds.
  useEffect(() => {
    void window.marudesk.invoke('browser:set-visible', false);
    return () => {
      void window.marudesk.invoke('browser:set-visible', true);
    };
  }, []);

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(TAB_DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setZone(pickZone(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY));
  };
  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(TAB_DND_MIME)) return;
    e.preventDefault();
    const id = e.dataTransfer.getData(TAB_DND_MIME) || draggedTabId;
    const z =
      zone ?? pickZone(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
    setZone(null);
    if (!id) return;
    const { dir, side } = zoneToSplit(z);
    // targetLeafId = null → seed a fresh 2-pane grid from the active tab.
    splitWith(null, id, dir, side);
  };

  const hint =
    zone === 'left'
      ? 'inset-y-0 left-0 w-1/2'
      : zone === 'right'
        ? 'inset-y-0 right-0 w-1/2'
        : zone === 'top'
          ? 'inset-x-0 top-0 h-1/2'
          : zone === 'bottom'
            ? 'inset-x-0 bottom-0 h-1/2'
            : '';

  return (
    <div
      className="absolute inset-0 z-40 bg-surface-page"
      aria-label="Drop a tab to split the view"
      onDragOver={onDragOver}
      onDragLeave={() => setZone(null)}
      onDrop={onDrop}
    >
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none text-center px-8">
        <span className="text-caption uppercase tracking-wider text-fg-tertiary">
          Split view
        </span>
        <p className="text-body-sm text-fg-tertiary max-w-xs">
          Drop near an edge to tile this tab beside the current one.
        </p>
      </div>
      {zone ? (
        <div
          aria-hidden
          className={cn(
            'absolute rounded-sm bg-accent/20 border border-accent pointer-events-none',
            hint,
          )}
        />
      ) : null}
    </div>
  );
}
