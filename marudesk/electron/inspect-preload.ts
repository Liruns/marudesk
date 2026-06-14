/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron';

// Whether the infinite canvas currently owns this web view (pane mode). Main
// broadcasts it on every pane-bounds change, so a card added later is covered
// too. Off in the classic shell, where the page keeps its own Ctrl+wheel zoom.
let canvasPaneMode = false;
ipcRenderer.on('canvas:pane-mode', (_e, on: unknown) => {
  canvasPaneMode = on === true;
});

// On the canvas a web card is a native WebContentsView composited ABOVE the React
// surface, so it swallows wheel events — Ctrl/Cmd+wheel would zoom the page, out
// of sync with the canvas. While the canvas owns this view, capture that gesture
// (preventDefault stops the page zoom) and hand it to the canvas to zoom instead.
// Plain wheel is left alone so the page still scrolls.
window.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    if (!canvasPaneMode || (!e.ctrlKey && !e.metaKey)) return;
    e.preventDefault();
    ipcRenderer.send('canvas:web-wheel', { deltaY: e.deltaY });
  },
  { passive: false, capture: true },
);

contextBridge.exposeInMainWorld('__marudeskBridge', {
  capture(payload: unknown) {
    ipcRenderer.send('inspect:capture', payload);
  },
  exit() {
    ipcRenderer.send('inspect:exit');
  },
  // Floating stage toolbar (§3.2): start the element picker from inside the page.
  startInspect() {
    ipcRenderer.send('inspect:start');
  },
});
