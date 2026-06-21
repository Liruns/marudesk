import { useEffect, useRef, useState } from 'react';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import { cdpTry } from '../cdp';
import { layoutKind } from './elements-utils';

/**
 * Per-selected-node grid/flex overlay toggles (Overlay.setShowGridOverlays /
 * setShowFlexOverlays). Rendered only when the selected node's computed
 * `display` makes it a grid or flex container (the Elements panel already
 * fetches computed styles on selection — no extra round-trip). Overlay state is
 * sticky on the page (§E), so both lists are cleared whenever the selection or
 * tab binding changes, and on unmount.
 */

// Overlay paint colors: the rgba components of the UI accent token
// (--accent #C75A3B). These are CDP overlay params Chromium paints ON THE PAGE,
// not component CSS — the design-token rule covers UI styles, so mirroring the
// accent value by hand here is intentional (CDP params can't reference CSS vars).
const accent = (a: number) => ({ r: 199, g: 90, b: 59, a });

const GRID_HIGHLIGHT_CONFIG = {
  rowLineColor: accent(0.9),
  columnLineColor: accent(0.9),
  rowGapColor: accent(0.25),
  columnGapColor: accent(0.25),
  rowLineDash: true,
  columnLineDash: true,
  showGridExtensionLines: false,
  showTrackSizes: true,
};

const FLEX_HIGHLIGHT_CONFIG = {
  containerBorder: { color: accent(0.9), pattern: 'dashed' },
  itemSeparator: { color: accent(0.7), pattern: 'dotted' },
  lineSeparator: { color: accent(0.7), pattern: 'dashed' },
  mainDistributedSpace: { fillColor: accent(0.15) },
  crossDistributedSpace: { fillColor: accent(0.1) },
};

export function LayoutOverlays() {
  const tabId = useDevtoolsStore((s) => s.tabId);
  const selectedId = useDevtoolsStore((s) => s.selectedId);
  const kind = useDevtoolsStore((s) =>
    layoutKind(s.styles?.computed.find((c) => c.name === 'display')?.value),
  );
  const [gridOn, setGridOn] = useState(false);
  const [flexOn, setFlexOn] = useState(false);
  // True once any overlay was shown for the current selection — gates the
  // cleanup so selection changes without overlays don't fire no-op CDP calls.
  const activeRef = useRef(false);

  // Reset the toggles on selection/tab change via the store-previous-prop
  // pattern (render-time, no effect cascade).
  const key = `${tabId ?? ''}:${selectedId ?? 'none'}`;
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setGridOn(false);
    setFlexOn(false);
  }

  // The page-side clear has to be an effect cleanup: it must fire on the OLD
  // tab/selection (closed over here) when they change, and on unmount/detach.
  useEffect(() => {
    if (!tabId) return;
    const boundTab = tabId;
    return () => {
      if (!activeRef.current) return;
      activeRef.current = false;
      void cdpTry(boundTab, 'Overlay.setShowGridOverlays', { gridNodeHighlightConfigs: [] });
      void cdpTry(boundTab, 'Overlay.setShowFlexOverlays', { flexNodeHighlightConfigs: [] });
    };
  }, [tabId, selectedId]);

  if (tabId === null || selectedId === null || kind === null) return null;

  const toggle = (which: 'grid' | 'flex') => {
    const next = which === 'grid' ? !gridOn : !flexOn;
    if (which === 'grid') setGridOn(next);
    else setFlexOn(next);
    if (next) activeRef.current = true;
    if (which === 'grid') {
      void cdpTry(tabId, 'Overlay.setShowGridOverlays', {
        gridNodeHighlightConfigs: next
          ? [{ nodeId: selectedId, gridHighlightConfig: GRID_HIGHLIGHT_CONFIG }]
          : [],
      });
    } else {
      void cdpTry(tabId, 'Overlay.setShowFlexOverlays', {
        flexNodeHighlightConfigs: next
          ? [{ nodeId: selectedId, flexboxHighlightConfig: FLEX_HIGHLIGHT_CONFIG }]
          : [],
      });
    }
  };

  const button = (which: 'grid' | 'flex', on: boolean, label: string) => (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => toggle(which)}
      className={cn(
        'h-5 px-1.5 rounded text-caption font-mono transition-colors duration-fast',
        on
          ? 'bg-accent-subtle/60 text-accent'
          : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="shrink-0 flex items-center gap-1 px-1.5 py-1 border-b border-subtle">
      <span className="text-caption text-fg-tertiary mr-0.5">layout</span>
      {kind === 'grid' ? button('grid', gridOn, 'Show grid overlay') : null}
      {kind === 'flex' ? button('flex', flexOn, 'Show flex overlay') : null}
    </div>
  );
}
