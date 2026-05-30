import { useEffect } from 'react';
import { ExternalLink } from 'lucide-react';
import { useDevtoolsStore } from './store';
import { PANELS } from './panel-list';
import { PanelTab } from './panels';
import { DevtoolsBody } from './DevtoolsBody';

/**
 * The pop-out DevTools window's root (App.tsx routes `#/devtools/<tabId>` here).
 * It runs a SELF-CONTAINED bridge — not useDevtoolsEvents, which subscribes to
 * the tab strip that doesn't exist in this renderer — wiring just the two events
 * the panels need (`devtools:cdp-event` ingest + `devtools:detached` reset), and
 * opens a session for the bound tab on mount.
 *
 * The popup drives the same single CDP relay as the dock: the dock detached
 * before main opened this window, and we re-attach here via `_openFor`. CDP
 * events follow this window while it's open (cdp.ts `eventTarget`).
 *
 * Capture ("Add to AI context") is hidden in window mode — the composer lives in
 * the main window and cross-window capture is out of scope.
 */
export function DevtoolsWindow({ tabId }: { tabId: string }) {
  useEffect(() => {
    const store = useDevtoolsStore.getState();
    store.setWindowMode(true);

    const offEvent = window.marudesk.on('devtools:cdp-event', (payload) => {
      if (payload.tabId !== useDevtoolsStore.getState().tabId) return;
      useDevtoolsStore.getState().ingestBatch(payload.items, payload.dropped);
    });
    const offDetached = window.marudesk.on('devtools:detached', (payload) => {
      useDevtoolsStore.getState().handleDetached(payload.tabId, payload.reason);
    });

    // Open the session for the bound tab (side is irrelevant — we render
    // full-bleed). The bridge above is already live, so no early events are lost.
    void store._openFor(tabId, 'right');

    return () => {
      offEvent();
      offDetached();
    };
  }, [tabId]);

  const panel = useDevtoolsStore((s) => s.panel);
  const dropped = useDevtoolsStore((s) => s.dropped);

  const dockBack = () => {
    void window.marudesk.invoke('devtools:popout-close');
    window.close();
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-1 text-fg-primary overflow-hidden">
      <div className="shrink-0 h-9 flex items-center gap-0.5 pl-2 pr-1 border-b border-subtle bg-surface-2/40">
        {PANELS.map((p) => (
          <PanelTab
            key={p.id}
            label={p.label}
            active={panel === p.id}
            onClick={() => useDevtoolsStore.getState().setPanel(p.id)}
          />
        ))}
        <div className="flex-1" />
        {dropped > 0 ? (
          <span
            title={`${dropped} events dropped (event flood)`}
            className="text-caption text-warning px-1.5 tabular-nums"
          >
            {dropped} dropped
          </span>
        ) : null}
        <button
          type="button"
          aria-label="Dock back into the main window"
          title="Dock back into the main window"
          onClick={dockBack}
          className="h-7 px-2 rounded flex items-center gap-1 text-body-sm text-fg-tertiary hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast"
        >
          <ExternalLink size={14} className="rotate-180" />
          Dock back
        </button>
      </div>
      <DevtoolsBody />
    </div>
  );
}
