import { type WebContents } from 'electron';
import {
  errorCount,
  getDevtoolsWindow,
  getHost,
  isNetworkCaptureOn,
  pushError,
  pushNetwork,
  setNetworkCapture,
  type TabRecord,
} from './state';
import { extractConsoleError } from '../../shared/runtime-evidence';
import { extractNetwork } from '../../shared/network-evidence';
import { coalesced } from '../coalesce';

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
  // Application panel: local/session storage CRUD (DOMStorage) and per-origin
  // "Clear site data" + usage (Storage). Destructive whole-browser variants
  // (Storage.clearCookies) are subtracted in BLOCKED_METHODS below.
  'DOMStorage.',
  'Storage.',
  // Rendering panel: media / vision-deficiency emulation only. The prefix would
  // otherwise also admit environment-override WRITES (UA / geolocation / device
  // metrics / timezone / locale / sensors) — those are subtracted in
  // BLOCKED_METHODS below so the prefix can't re-admit them.
  'Emulation.',
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
  // Whole-browser cookie wipe — parallels the blocked Network.clearBrowserCookies.
  // The Application panel's "Clear site data" uses the origin-scoped
  // Storage.clearDataForOrigin (still allowed) instead.
  'Storage.clearCookies',
  // Storage-domain twins of the blocked Network.* cookie writes + quota/bucket
  // mutations the Application panel never issues (it only reads cookies and
  // clears per-origin site data). Kept tight so the 'Storage.' prefix can't be
  // used to write cookies or fiddle storage buckets.
  'Storage.setCookies',
  'Storage.overrideQuotaForOrigin',
  'Storage.setStorageBucketTracking',
  'Storage.deleteStorageBucket',
  // Emulation environment-override WRITES the Rendering panel never issues (it
  // uses only setEmulatedMedia / setEmulatedVisionDeficiency). Subtracted so the
  // 'Emulation.' prefix can't spoof UA / geolocation / device / locale / time /
  // sensors. Mirrors the blocked Network.setUserAgentOverride.
  'Emulation.setUserAgentOverride',
  'Emulation.setGeolocationOverride',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.setTouchEmulationEnabled',
  'Emulation.setIdleOverride',
  'Emulation.setLocaleOverride',
  'Emulation.setTimezoneOverride',
  'Emulation.setSensorOverrideEnabled',
  'Emulation.setSensorOverrideReadings',
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

// Tabs whose always-on error count changed since the last flush — coalesced
// into the same setImmediate tick as the event relay, so a page throwing in a
// tight loop can't spam one IPC per error.
const errorCountDirty = new Set<string>();

// One flush per tick (../coalesce): the renderer only needs the latest batch.
const scheduleFlush = coalesced(flushBuffers);

/**
 * The renderer that should receive CDP events/detach notices: the pop-out
 * DevTools window while it's open, else the host. Events follow the popup so the
 * detached-into-a-window panels stay live; nav/tab pushes in state.ts stay on
 * the host (those drive the toolbar/strip, which only exist there).
 */
function eventTarget(): Electron.BrowserWindow | null {
  const popup = getDevtoolsWindow();
  if (popup && !popup.isDestroyed()) return popup;
  const host = getHost();
  return host && !host.isDestroyed() ? host : null;
}

function flushBuffers(): void {
  // CDP events follow the pop-out DevTools window while it's open (so its panels
  // stay live).
  const target = eventTarget();
  if (target) {
    for (const [tabId, buf] of buffers) {
      if (buf.items.length > 0 || buf.dropped > 0) {
        target.webContents.send('devtools:cdp-event', {
          tabId,
          items: buf.items,
          dropped: buf.dropped || undefined,
        });
      }
    }
  }
  buffers.clear();
  // The error badge lives on the host toolbar (the popup has no tab strip), so
  // it always goes to the host — not whichever window is the cdp-event target.
  if (errorCountDirty.size > 0) {
    const host = getHost();
    if (host && !host.isDestroyed()) {
      for (const tabId of errorCountDirty) {
        host.webContents.send('devtools:error-count', {
          tabId,
          count: errorCount(tabId),
        });
      }
    }
    errorCountDirty.clear();
  }
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
    // Always-on console capture (P0): sift errors into the per-tab ring buffer
    // regardless of the relay buffer or whether the dock is open. Runs before
    // the cap/DROP gates below so a flood of other events can't drop an error.
    const evidence = extractConsoleError(method, params);
    if (evidence) {
      pushError(rec.id, evidence);
      errorCountDirty.add(rec.id);
      scheduleFlush();
    }
    // On-demand network capture (P0.5): only when the agent enabled it for this
    // tab — keeps the always-on path Runtime-only. Buffer is raw; the tool
    // scrubs at egress.
    if (isNetworkCaptureOn(rec.id)) {
      const nrec = extractNetwork(method, params);
      if (nrec) pushNetwork(rec.id, nrec);
    }
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
    const target = eventTarget();
    if (target) {
      target.webContents.send('devtools:detached', {
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

/**
 * Passively enable always-on console capture (P0) on a web tab: attach our CDP
 * client and enable Runtime so JS errors (`exceptionThrown` /
 * `consoleAPICalled`) stream into the ring buffer — no panel UI, and only the
 * low-volume Runtime domain (Network/DOM stay off, and Log — mostly
 * network/resource noise, P0.5 — is left for the dock to enable when opened).
 * Idempotent: safe on every load start and after navigation. Skips a tab whose
 * built-in Chromium DevTools holds the single per-page CDP client.
 */
export function enableConsoleCapture(rec: TabRecord): void {
  if (rec.kind !== 'web' || !rec.view) return;
  if (rec.chromeDevtoolsOpen) return; // built-in DevTools owns the client
  attachCdp(rec);
  if (!rec.cdpAttached) return; // attach lost the race / contents gone
  void sendCdp(rec, 'Runtime.enable').catch(() => {});
}

/**
 * Lazily enable network capture (P0.5) on a web tab for the agent's
 * `read_network` tool: attach our CDP client (if needed), flip the per-tab gate
 * so the message relay starts buffering responses/failures, and enable the
 * Network domain. Idempotent. Skips a tab whose built-in Chromium DevTools holds
 * the single per-page CDP client. Returns true when capture is live.
 *
 * Sharing with the custom React DevTools Network panel is intentional and safe:
 * both consume the one debugger's stream independently (the panel buffers in the
 * renderer via cdp-event; this gate buffers in main via pushNetwork), and
 * Network.enable is idempotent. The gate is dropped when the agent turn ends
 * (loop.finish) so the always-on relay returns to Runtime-only.
 */
export async function enableNetworkCapture(rec: TabRecord): Promise<boolean> {
  if (rec.kind !== 'web' || !rec.view) return false;
  if (rec.chromeDevtoolsOpen) return false; // built-in DevTools owns the client
  attachCdp(rec);
  if (!rec.cdpAttached) return false;
  setNetworkCapture(rec.id, true);
  try {
    await sendCdp(rec, 'Network.enable');
    return true;
  } catch {
    return false;
  }
}

/**
 * Queue an error-count push for a tab, coalesced into the next flush tick.
 * Used by ./tabs to reset the badge to 0 after clearing the buffer on a
 * main-frame navigation.
 */
export function refreshErrorBadge(tabId: string): void {
  errorCountDirty.add(tabId);
  scheduleFlush();
}
