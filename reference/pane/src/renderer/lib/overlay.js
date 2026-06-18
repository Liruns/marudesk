// Coordinates the chrome-grow overlays (suggestions / menu / find): only one open at a
// time, and a single place that grows/shrinks the chrome view.
let activeClose = null;

export function openOverlay(closeFn, height) {
  if (activeClose && activeClose !== closeFn) activeClose(); // close the other overlay
  activeClose = closeFn;
  window.pane.setChromeHeight(height);
}

export function closeOverlay(closeFn) {
  if (activeClose === closeFn) {
    activeClose = null;
    window.pane.setChromeHeight(baseHeight());
  }
}

function baseHeight() {
  return Math.ceil(document.getElementById('toolbar').getBoundingClientRect().bottom);
}
