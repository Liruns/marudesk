import { getTab, type TabRecord } from '../../browser/state';
import { sendCdp } from '../../browser/cdp';

/**
 * Agent page highlights — draw a transient, labeled box over the element a
 * browser tool is about to touch, injected into the page itself. The web view is
 * a native WebContentsView composited above the renderer, so a renderer-side
 * overlay can't sit on top of it; the DOM-inspect picker
 * (`electron/inspect-overlay.ts`) uses the same in-page technique. Best-effort
 * and fire-and-forget: a missing element, a navigating page, or a CDP hiccup is
 * swallowed so a highlight never blocks or fails the tool call that drew it.
 *
 * The accent hex mirrors the inspect overlay (injected page chrome, not a
 * component — the no-hard-coded-color rule governs the React surface). The box
 * auto-removes after the TTL; on a navigation the new document drops the nodes,
 * so no teardown channel is needed.
 */

const HIGHLIGHT_TTL = 2_000;
// A preview drawn while a gated action waits for approval persists until the
// decision clears it (see clearActionPreview); the long TTL is only a backstop
// so a dropped clear can't leave a box on the page forever.
const PREVIEW_TTL = 60_000;

// Gated interaction tools that resolve a single selector — the ones worth
// previewing on the page before the user approves them.
const PREVIEWABLE = new Set(['click', 'fill', 'press_key', 'scroll']);

// Self-contained page function: selector + label arrive as JSON-encoded data,
// never spliced as code (same injection-safety contract as the runtime tools).
const HIGHLIGHT_FN = String.raw`function (selector, label, ttl) {
  try {
    var el = document.querySelector(selector);
    if (!el) return false;
    var ACCENT = '#C75A3B';
    var r = el.getBoundingClientRect();
    var box = document.createElement('div');
    box.setAttribute('data-marudesk-agent-highlight', '');
    box.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:2147483645',
      'box-sizing:border-box', 'border:2px solid ' + ACCENT,
      'background:rgba(199,90,59,0.10)', 'border-radius:3px',
      'transition:opacity 120ms ease', 'opacity:1',
      'top:' + r.top + 'px', 'left:' + r.left + 'px',
      'width:' + r.width + 'px', 'height:' + r.height + 'px'
    ].join(';');
    var tag = document.createElement('div');
    tag.setAttribute('data-marudesk-agent-highlight', '');
    tag.textContent = label;
    var top = r.top - 18 < 2 ? r.bottom + 2 : r.top - 18;
    tag.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:2147483645',
      'background:' + ACCENT, 'color:#fff',
      'font:11px ui-sans-serif,system-ui,-apple-system,Inter,sans-serif',
      'font-variant-numeric:tabular-nums',
      'padding:1px 6px', 'border-radius:3px', 'white-space:nowrap',
      'max-width:280px', 'overflow:hidden', 'text-overflow:ellipsis',
      'top:' + top + 'px', 'left:' + Math.max(2, r.left) + 'px'
    ].join(';');
    var root = document.documentElement;
    root.appendChild(box);
    root.appendChild(tag);
    setTimeout(function () { box.style.opacity = '0'; tag.style.opacity = '0'; }, ttl - 120);
    setTimeout(function () { box.remove(); tag.remove(); }, ttl);
    return true;
  } catch (e) {
    return false;
  }
}`;

// Removes any highlight nodes left in the page (the preview, before its TTL).
const CLEAR_FN = String.raw`function () {
  try {
    var ns = document.querySelectorAll('[data-marudesk-agent-highlight]');
    for (var i = 0; i < ns.length; i++) ns[i].remove();
  } catch (e) {}
}`;

/**
 * Draw a transient highlight over `selector` in the tab's live page. No-op for an
 * empty selector or a tab without a view; failures are swallowed so the calling
 * tool's own result is never affected.
 */
export function highlightInPage(
  rec: TabRecord,
  selector: string,
  label: string,
  ttl: number = HIGHLIGHT_TTL,
): void {
  if (!selector || !rec.view) return;
  const expr = `(${HIGHLIGHT_FN})(${JSON.stringify(selector)}, ${JSON.stringify(label)}, ${ttl})`;
  void sendCdp(rec, 'Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: false,
    timeout: 1_500,
  }).catch(() => undefined);
}

/**
 * Preview a gated interaction tool on the page while it waits for approval, so
 * the user can see the exact target before deciding (Stagehand-style preview).
 * Persists until {@link clearActionPreview} runs on the decision. No-op for
 * non-previewable tools, a selectorless input, or a non-web tab.
 */
export function previewGatedAction(tabId: string | undefined, name: string, input: unknown): void {
  if (!tabId || !PREVIEWABLE.has(name)) return;
  const sel =
    input && typeof input === 'object'
      ? (input as { selector?: unknown }).selector
      : undefined;
  if (typeof sel !== 'string' || !sel) return;
  const rec = getTab(tabId);
  if (!rec || rec.kind !== 'web' || !rec.view) return;
  highlightInPage(rec, sel, name === 'press_key' ? 'press' : name, PREVIEW_TTL);
}

/** Clear a gated-action preview (called once the approval decision is made). */
export function clearActionPreview(tabId: string | undefined): void {
  if (!tabId) return;
  const rec = getTab(tabId);
  if (!rec || rec.kind !== 'web' || !rec.view) return;
  void sendCdp(rec, 'Runtime.evaluate', {
    expression: `(${CLEAR_FN})()`,
    returnByValue: true,
    awaitPromise: false,
    timeout: 1_000,
  }).catch(() => undefined);
}
