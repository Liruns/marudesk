import { useEffect } from 'react';
import { MousePointerSquareDashed } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import { DomTree } from '../components/DomTree';
import { StylesPane } from '../components/StylesPane';

/**
 * Elements panel: an element picker (CDP `Overlay.setInspectMode`), the DOM
 * tree, and the styles inspector beneath it. The picker draws Chromium's native
 * highlight + "click to select" over the page; the selected node flows back
 * through `Overlay.inspectNodeRequested` (handled in the store).
 */
export function ElementsPanel() {
  const picking = useDevtoolsStore((s) => s.picking);

  // Esc cancels picking, matching the page-side inspect overlay.
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void useDevtoolsStore.getState().stopPick();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking]);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 h-8 flex items-center px-1.5 border-b border-subtle gap-1">
        <button
          type="button"
          aria-pressed={picking}
          aria-label="Pick an element"
          title="Select an element in the page"
          onClick={() => {
            const s = useDevtoolsStore.getState();
            if (s.picking) void s.stopPick();
            else void s.startPick();
          }}
          className={cn(
            'size-6 rounded flex items-center justify-center transition-colors duration-fast',
            picking
              ? 'text-accent bg-accent-subtle/50'
              : 'text-fg-tertiary hover:text-fg-primary hover:bg-surface-2',
          )}
        >
          <MousePointerSquareDashed size={15} />
        </button>
      </div>
      <div className="flex-[3] min-h-0 border-b border-subtle">
        <DomTree />
      </div>
      <div className="flex-[2] min-h-0">
        <StylesPane />
      </div>
    </div>
  );
}
