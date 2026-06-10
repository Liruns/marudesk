// Pre-paint theme guard: set data-theme (and data-palette) before the bundle
// loads so a light-theme or palette user never sees the default dark first
// frame. Mirrors what the settings store caches in localStorage; mode falls
// back to the OS preference. Lives as an external classic script (synchronous,
// in <head>) instead of an inline one: the packaged build's CSP is
// `script-src 'self'`, which silently blocked the previous inline version (dev
// allowed it via 'unsafe-inline', hiding the gap).
try {
  var m = localStorage.getItem('marudesk.theme');
  if (
    m === 'light' ||
    ((!m || m === 'system') &&
      window.matchMedia('(prefers-color-scheme: light)').matches)
  ) {
    document.documentElement.dataset.theme = 'light';
  }
  // Keep this allowlist in sync with THEME_PALETTES in shared/settings.ts.
  var p = localStorage.getItem('marudesk.theme.palette');
  if (p === 'midnight' || p === 'espresso' || p === 'fjord' || p === 'paper') {
    document.documentElement.dataset.palette = p;
  }
} catch (e) {
  /* best-effort */
}
