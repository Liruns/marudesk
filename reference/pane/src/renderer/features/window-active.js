// Window focus state → chrome inert shift (DESIGN §14 "Window blurred").
// When the app loses focus the toolbar reads muted (a subtle desaturate/dim), matching
// native Win11 inactive-window behavior. Main reports the state; the CSS does the rest.
export function initWindowActive() {
  const root = document.documentElement;
  const apply = (active) => root.classList.toggle('inactive', !active);
  apply(document.hasFocus()); // sensible default until main syncs the real state
  window.pane.onWindowActive((d) => apply(d && d.active));
}
