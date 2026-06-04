import type { Rect } from '../../../shared/ipc';

type BrowserPane = {
  readonly tabId: string;
  readonly rect: Rect;
};

const sources = new Map<string, readonly BrowserPane[]>();
let flushQueued = false;

function scheduleFlush(): void {
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    const panes = [...sources.values()].flat();
    if (panes.length === 0) {
      void window.marudesk.invoke('browser:clear-pane-bounds');
      return;
    }
    void window.marudesk.invoke('browser:set-pane-bounds', { panes });
  });
}

export function setBrowserPaneBoundsSource(
  sourceId: string,
  panes: readonly BrowserPane[],
): void {
  sources.set(sourceId, panes);
  scheduleFlush();
}

export function clearBrowserPaneBoundsSource(sourceId: string): void {
  if (!sources.delete(sourceId)) return;
  scheduleFlush();
}
