import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useI18n } from '../../i18n/useI18n';
import { WorkGraphStage } from './WorkGraphStage';
import { InstrumentStage } from './InstrumentStage';
import { useInstrumentStore } from './instrument';

/**
 * Mission Control's main stage. The Task graph (canvas) is the home; when a tool
 * is summoned it docks BESIDE the canvas as a resizable Workbench rather than
 * replacing it, so the task map stays visible while you work in a browser /
 * editor / terminal / chat (the features harmonise instead of taking turns).
 *
 *  - no tool open   → the canvas owns the whole stage.
 *  - tool open      → [ canvas | divider | workbench ], the divider drags the
 *                     split (persisted), each side reports its own rect so the
 *                     native tool views tile beside the DOM canvas.
 *  - maximized      → the workbench fills; the canvas is hidden (a focus mode,
 *                     toggled from the workbench header, restored from there too).
 *
 * Tools are SIBLINGS of the graph, never cards on its plane — that is
 * WorkGraphStage's stated philosophy; this keeps them visible together without
 * muddling the dependency DAG.
 */
export function MainStage() {
  const { t } = useI18n();
  const instrumentTabId = useInstrumentStore((s) => s.tabId);
  const canvasRatio = useInstrumentStore((s) => s.canvasRatio);
  const maximized = useInstrumentStore((s) => s.maximized);
  const setCanvasRatio = useInstrumentStore((s) => s.setCanvasRatio);
  const rowRef = useRef<HTMLDivElement>(null);

  if (!instrumentTabId) return <WorkGraphStage docked />;
  if (maximized) return <InstrumentStage />;

  const onDividerDown = (e: ReactPointerEvent): void => {
    e.preventDefault();
    const move = (ev: PointerEvent): void => {
      const el = rowRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setCanvasRatio((ev.clientX - r.left) / r.width);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div ref={rowRef} className="flex-1 min-w-0 min-h-0 flex">
      <div className="relative min-w-0 min-h-0 flex" style={{ flexGrow: canvasRatio, flexBasis: 0 }}>
        <WorkGraphStage docked />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('workGraph.workbench.resize')}
        onPointerDown={onDividerDown}
        onDoubleClick={() => setCanvasRatio(0.5)}
        className="relative z-20 w-px shrink-0 cursor-col-resize bg-subtle hover:bg-accent transition-colors duration-fast"
      >
        {/* Wider invisible hit target so the 1px seam is easy to grab. */}
        <span aria-hidden className="absolute -inset-x-1 inset-y-0" />
      </div>
      <div className="relative min-w-0 min-h-0 flex" style={{ flexGrow: 1 - canvasRatio, flexBasis: 0 }}>
        <InstrumentStage />
      </div>
    </div>
  );
}
