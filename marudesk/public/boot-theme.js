// Pre-paint theme guard: set data-theme before the bundle loads so a
// light-theme user never sees a dark first frame. Mirrors the mode the settings
// store caches in localStorage; falls back to the OS preference. Lives as an
// external classic script (synchronous, in <head>) instead of an inline one:
// the packaged build's CSP is `script-src 'self'`, which silently blocked the
// previous inline version (dev allowed it via 'unsafe-inline', hiding the gap).
try {
  var m = localStorage.getItem('marudesk.theme');
  if (
    m === 'light' ||
    ((!m || m === 'system') &&
      window.matchMedia('(prefers-color-scheme: light)').matches)
  ) {
    document.documentElement.dataset.theme = 'light';
  }
} catch (e) {
  /* best-effort */
}
