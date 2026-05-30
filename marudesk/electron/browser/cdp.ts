import { type WebContents } from 'electron';
import { getHost, type TabRecord } from './state';

/**
 * CDP relay for the custom DevTools. Rather than host Chromium's DevTools UI
 * (see ./devtools), we attach our own Chrome DevTools Protocol client to a web
 * tab's webContents and relay commands/events to the renderer's React panels.
 *
 * - Commands: the renderer sends `devtools:cdp-send`; the handler calls
 *   `sendCdp`, which whitelists the method then awaits `debugger.sendCommand`
 *   (the promise already correlates request↔response — no id bookkeeping).
 * - Events: CDP can emit thousands of messages/sec (Network/DOM), so the
 *   `debugger.on('message')` stream is COALESCED per tab and flushed once per
 *   tick as a batch over `devtools:cdp-event` — never one IPC per event.
 * - Lifecycle: listeners are wired once per webContents (they survive
 *   attach/detach cycles). An EXTERNAL detach (renderer crash, or the built-in
 *   DevTools opening on the same contents) fires `'detach'`, which resets state
 *   and notifies the renderer via `devtools:detached`.
 *
 * Package leaf-consumer: imports only ./state (and `getHost` to reach the
 * renderer), never its siblings — no import cycle.
 */

// Renderer-originated CDP methods are validated against an EXACT domain-prefix
// allowlist, so e.g. 'DOM.' never also admits 'DOMStorage'/'DOMDebugger'.
const ALLOWED_PREFIXES = [
  'DOM.',
  'CSS.',
  'Overlay.',
  'Runtime.',
  'Network.',
  'Log.',
  'Page.',
  'Debugger.',
  'Profiler.',
  'Performance.',
];
// Exact methods outside the allowed domains we still need: auto-attach to
// out-of-process iframes / workers (Sources). The dangerous Target methods
// (createTarget / attachToTarget to arbitrary targets) stay blocked by omission.
const ALLOWED_EXACT = new Set(['Target.setAutoAttach', 'Target.getTargetInfo']);

// A domain-prefix allow-list admits EVERY method in an allowed domain, including
// escape/destructive ones (request interception, cookie/cache mutation,
// navigation hijack, CSP bypass). Those are subtracted here and checked first,
// so the prefix allow can't re-admit them. (Defense-in-depth: the host renderer
// is trusted, but page content must never reach these via a confused deputy.)
const BLOCKED_METHODS = new Set([
  'Network.setRequestInterception',
  'Network.continueInterceptedRequest',
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Network.clearBrowserCookies',
  'Network.clearBrowserCache',
  'Network.setBlockedURLs',
  'Network.replayXHR',
  'Network.setUserAgentOverride',
  'Network.setExtraHTTPHeaders',
  'Page.navigate',
  'Page.navigateToHistoryEntry',
  'Page.setDownloadBehavior',
  'Page.setBypassCSP',
  'Page.setInterceptFileChooserDialog',
  'Page.crash',
  'Page.close',
]);

export function isAllowedCdpMethod(method: string): boolean {
  if (BLOCKED_METHODS.has(method)) return false;
  if (ALLOWED_EXACT.has(method)) return true;
  return ALLOWED_PREFIXES.some((p) => method.startsWith(p));
}

// Hot, low-value events dropped in main before they ever cross IPC.
const DROP_METHODS = new Set(['Network.dataReceived']);

// Coalescing bounds IPC *frequency* (one send per tab per tick) but not per-tick
// *volume* — a flooding page could pile tens of thousands of events (each
// retaining its full params) into one giant structured-clone. Cap the per-tick
// buffer and report the overflow count so the renderer can show "N dropped"
// instead of either silently losing data or stalling the main process.
const MAX_ITEMS_PER_TICK = 3000;

type EventItem = { sessionId?: string; method: string; params: unknown };
type TabBuffer = { items: EventItem[]; dropped: number };

// Per-tab outgoing event buffer, flushed once per tick (setImmediate).
const buffers = new Map<string, TabBuffer>();
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(flushBuffers);
}

function flushBuffers(): void {
  flushScheduled = false;
  const host = getHost();
  if (!host || host.isDestroyed()) {
    buffers.clear();
    return;
  }
  for (const [tabId, buf] of buffers) {
    if (buf.items.length > 0 || buf.dropped > 0) {
      host.webContents.send('devtools:cdp-event', {
        tabId,
        items: buf.items,
        dropped: buf.dropped || undefined,
      });
    }
  }
  buffers.clear();
}

// Listeners are attached once per webContents (they survive attach/detach
// cycles); the WeakSet entry vanishes when the contents is GC'd.
const wired = new WeakSet<WebContents>();

function wireListeners(rec: TabRecord, wc: WebContents): void {
  if (wired.has(wc)) return;
  wired.add(wc);
  const dbg = wc.debugger;
  dbg.on('message', (_event, method, params, sessionId) => {
    // Gate on attach state: after an explicit detach the listener is still live
    // (we never remove it — leak-free re-attach relies on the WeakSet wiring),
    // so without this a trailing in-flight message could buffer + flush for a
    // session the renderer already tore down.
    if (!rec.cdpAttached) return;
    if (DROP_METHODS.has(method)) return;
    let buf = buffers.get(rec.id);
    if (!buf) {
      buf = { items: [], dropped: 0 };
      buffers.set(rec.id, buf);
    }
    if (buf.items.length >= MAX_ITEMS_PER_TICK) {
      buf.dropped++;
      return;
    }
    buf.items.push({ sessionId: sessionId || undefined, method, params });
    scheduleFlush();
  });
  dbg.on('detach', (_event, reason) => {
    buffers.delete(rec.id);
    // `detachCdp` clears `cdpAttached` BEFORE calling .detach(), so if Electron
    // ever fires this for our own explicit detach (its docs say it won't, but we
    // don't depend on that), it self-suppresses. Only an EXTERNAL detach (crash
    // / built-in DevTools opening) gets through to notify the renderer.
    if (!rec.cdpAttached) return;
    rec.cdpAttached = false;
    const host = getHost();
    if (host && !host.isDestroyed()) {
      host.webContents.send('devtools:detached', {
        tabId: rec.id,
        reason: String(reason),
      });
    }
  });
}

/**
 * Attach our CDP client to a web tab. Idempotent; guards against a re-entrant
 * attach race via `cdpAttaching`.
 */
export function attachCdp(rec: TabRecord): void {
  if (rec.kind !== 'web' || !rec.view) return;
  if (rec.cdpAttached || rec.cdpAttaching) return;
  const wc = rec.view.webContents;
  const dbg = wc.debugger;
  if (dbg.isAttached()) {
    rec.cdpAttached = true;
    wireListeners(rec, wc);
    return;
  }
  rec.cdpAttaching = true;
  try {
    dbg.attach('1.3');
  } catch {
    rec.cdpAttaching = false;
    // Lost a race / something else attached: treat as success iff truly attached.
    if (dbg.isAttached()) {
      rec.cdpAttached = true;
      wireListeners(rec, wc);
    }
    return;
  }
  rec.cdpAttaching = false;
  rec.cdpAttached = true;
  wireListeners(rec, wc);
}

/**
 * Detach explicitly (DevTools closed / tab closing / crash cleanup). Tolerant
 * of an already-gone contents — never throws. Does not rely on the 'detach'
 * event (that fires only on an external detach).
 */
export function detachCdp(rec: TabRecord): void {
  rec.cdpAttaching = false;
  // Clear BEFORE .detach() so the 'detach' listener self-suppresses if Electron
  // happens to fire it for an explicit detach — makes the explicit-vs-external
  // split robust to either Electron behavior.
  rec.cdpAttached = false;
  const wc = rec.view?.webContents;
  if (wc) {
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach();
    } catch {
      // contents already destroyed / never attached — ignore
    }
  }
  buffers.delete(rec.id);
}

/**
 * Send a CDP command after whitelisting the method. Lazily attaches if needed.
 * Resolves with the raw CDP result.
 */
export async function sendCdp(
  rec: TabRecord,
  method: string,
  params?: object,
  sessionId?: string,
): Promise<unknown> {
  if (!rec.view) throw new Error('marudesk: tab has no web view');
  if (!isAllowedCdpMethod(method)) {
    throw new Error(`marudesk: CDP method not allowed: ${method}`);
  }
  if (!rec.cdpAttached) attachCdp(rec);
  const dbg = rec.view.webContents.debugger;
  return sessionId
    ? dbg.sendCommand(method, params, sessionId)
    : dbg.sendCommand(method, params);
}
