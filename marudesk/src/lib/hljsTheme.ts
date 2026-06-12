// highlight.js token palettes for fenced code blocks (editor preview + AI chat),
// swapped to match the app theme. github-dark tokens on a light surface are
// near-invisible, so the palette must follow `data-theme` rather than being a
// single global import.
import darkCss from 'highlight.js/styles/github-dark.css?inline';
import lightCss from 'highlight.js/styles/github.css?inline';

const STYLE_ID = 'hljs-theme';

/**
 * Install (or swap) the highlight.js token palette for the given theme. Owns a
 * single `<style id="hljs-theme">` tag in `<head>`; idempotent and cheap, so the
 * settings store can call it on every appearance change.
 */
export function applyHljsTheme(theme: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(STYLE_ID);
  if (!(el instanceof HTMLStyleElement)) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = theme === 'light' ? lightCss : darkCss;
}
