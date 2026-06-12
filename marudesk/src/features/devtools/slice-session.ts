import type { StoreApi } from 'zustand';
import { cdpTry } from './cdp';
import { useTabsStore } from '../tabs/store';
import { useGridStore, groupForTab } from '../tabs/grid';
import { useSettingsStore } from '../settings/store';
import { DEFAULT_SIZE, MIN_SIZE, freshSlices, hasRenderingOverrides } from './store-internals';
import type { ConsoleEntry } from './types';
import type { DevtoolsState, DevtoolsActions } from './store';

type DevtoolsStore = DevtoolsState & DevtoolsActions;
type SetState = StoreApi<DevtoolsStore>['setState'];
type GetState = StoreApi<DevtoolsStore>['getState'];

type SessionActions = Pick<
  DevtoolsActions,
  | 'toggle'
  | 'reconnect'
  | '_openFor'
  | 'close'
  | 'popOut'
  | 'rebindToActive'
  | '_ensureDomains'
  | '_enablePanel'
  | '_handleNavigated'
  | '_seedConsoleErrors'
  | 'handleDetached'
>;

/**
 * The CDP session machine for the devtools store: open/close/reconnect/popout,
 * rebinding to the active tab, lazily enabling per-panel CDP domains, handling
 * navigation + always-on console-error seeding, and external detach. Extracted
 * from store.ts as a slice; `set`/`get` are passed in and sibling actions are
 * reached via `get()`.
 */
export function createSessionSlice(set: SetState, get: GetState): SessionActions {
  return {
    toggle: () => {
      const tabs = useTabsStore.getState();
      const active = tabs.tabs.find((t) => t.id === tabs.activeTabId);
      if (!active || active.kind !== 'web') return;
      const dock = useSettingsStore.getState().settings.devtools.defaultDock;
      if (dock === 'chrome') {
        void window.marudesk.invoke('devtools:open-chrome', { tabId: active.id });
        return;
      }
      // In grid/split mode the dock would fight the split layout — pop out
      // into a separate window instead of blocking the user entirely.
      const inGrid = groupForTab(useGridStore.getState().groups, active.id) !== null;
      if (inGrid) {
        void window.marudesk.invoke('devtools:popout-open', { tabId: active.id });
        return;
      }
      const s = get();
      if (s.open && s.tabId === active.id && s.session !== 'detached') {
        s.close();
      } else {
        void s._openFor(active.id, dock);
      }
    },

    reconnect: () => {
      const s = get();
      // In the pop-out window there's no tab strip — reconnect to the bound tab.
      if (s.windowMode) {
        if (s.tabId) void s._openFor(s.tabId, s.side);
        return;
      }
      const tabs = useTabsStore.getState();
      const active = tabs.tabs.find((t) => t.id === tabs.activeTabId);
      if (active?.kind === 'web') void s._openFor(active.id, s.side);
    },

    _openFor: async (tabId, side) => {
      const prev = get().tabId;
      const epoch = get().epoch + 1;
      const since = Date.now(); // boundary: live errors after this aren't seeded
      set({
        open: true,
        side,
        size: get().size >= MIN_SIZE ? get().size : DEFAULT_SIZE[side],
        tabId,
        session: 'attaching',
        detachReason: null,
        enabled: new Set(),
        epoch,
        ...freshSlices(),
      });
      // Defensive single-client: if a different tab was still bound (a rebind
      // caught mid-flight), detach it before attaching the new one.
      if (prev && prev !== tabId) {
        await window.marudesk.invoke('devtools:close', { tabId: prev });
        if (get().epoch !== epoch) return;
      }
      const ok = await window.marudesk.invoke('devtools:open', { tabId });
      if (get().epoch !== epoch) return; // a newer transition superseded us
      if (!ok) {
        set({ session: 'idle', open: false });
        return;
      }
      set({ session: 'attached' });
      // Page → main-frame nav re-enable (§4/§11.3); Runtime/Log → capture
      // console from the start.
      await get()._ensureDomains(['Page', 'Runtime', 'Log']);
      if (get().epoch !== epoch) return;
      await get()._enablePanel(get().panel);
      if (get().epoch !== epoch) return;
      // The drawer's panel is a second visible surface — enable its domains too.
      if (get().drawerOpen && get().drawerPanel !== get().panel) {
        await get()._enablePanel(get().drawerPanel);
        if (get().epoch !== epoch) return;
      }
      // Seed the console with errors main buffered before the dock opened.
      void get()._seedConsoleErrors(tabId, since);
      // Re-apply sticky rendering overrides — they reset on (re)attach.
      if (hasRenderingOverrides(get().rendering)) await get()._applyRendering();
    },

    close: () => {
      const tabId = get().tabId;
      if (tabId) {
        void cdpTry(tabId, 'Overlay.hideHighlight');
        void window.marudesk.invoke('devtools:close', { tabId });
      }
      set({
        open: false,
        tabId: null,
        session: 'idle',
        detachReason: null,
        enabled: new Set(),
        epoch: get().epoch + 1,
        ...freshSlices(),
      });
    },

    popOut: () => {
      const tabId = get().tabId;
      if (!tabId) return;
      // Single CDP client per page: detach the in-dock session cleanly first
      // (close() bumps the epoch + resets the machine), then ask main to open
      // the popup, which re-attaches in its own renderer.
      get().close();
      void window.marudesk.invoke('devtools:popout-open', { tabId });
    },

    rebindToActive: (tabId) => {
      const s = get();
      if (!s.open) return;
      if (tabId === s.tabId) return;
      // Active tab left the web kind (feature tab) — the dock unmounts with the
      // browser stage; keep the session so returning to this tab is instant.
      if (tabId === null) return;
      const old = s.tabId;
      const epoch = s.epoch + 1;
      const since = Date.now(); // boundary: live errors after this aren't seeded
      set({
        tabId,
        session: 'attaching',
        detachReason: null,
        enabled: new Set(),
        epoch,
        ...freshSlices(),
      });
      void (async () => {
        // Detach the previous tab BEFORE attaching the new one, so two opposing
        // IPCs can't reorder into a zombie debugger (single client per page).
        if (old) await window.marudesk.invoke('devtools:close', { tabId: old });
        if (get().epoch !== epoch) return;
        const ok = await window.marudesk.invoke('devtools:open', { tabId });
        if (get().epoch !== epoch) return;
        if (!ok) {
          set({ session: 'idle' });
          return;
        }
        set({ session: 'attached' });
        await get()._ensureDomains(['Page', 'Runtime', 'Log']);
        if (get().epoch !== epoch) return;
        await get()._enablePanel(get().panel);
        if (get().epoch !== epoch) return;
        if (get().drawerOpen && get().drawerPanel !== get().panel) {
          await get()._enablePanel(get().drawerPanel);
          if (get().epoch !== epoch) return;
        }
        void get()._seedConsoleErrors(tabId, since);
        if (hasRenderingOverrides(get().rendering)) await get()._applyRendering();
      })();
    },

    /* ── domain enable ───────────────────────────────────────────────── */

    _ensureDomains: async (domains) => {
      const tabId = get().tabId;
      if (!tabId) return;
      const enabled = get().enabled;
      const toEnable = domains.filter((d) => !enabled.has(d));
      if (toEnable.length === 0) return;
      const next = new Set(enabled);
      for (const d of toEnable) next.add(d);
      set({ enabled: next }); // optimistic — re-enable is harmless if it races
      await Promise.all(toEnable.map((d) => cdpTry(tabId, `${d}.enable`)));
    },

    _enablePanel: async (panel) => {
      if (panel === 'elements') {
        await get()._ensureDomains(['DOM', 'CSS', 'Overlay']);
        if (get().documentId === null) await get().refreshDocument();
      } else if (panel === 'console') {
        await get()._ensureDomains(['Runtime', 'Log']);
      } else if (panel === 'timeline') {
        // The runtime evidence timeline reads console errors + network failures,
        // so it needs both domains live (Network included, despite its flood
        // cost, or the timeline would silently miss request failures).
        await get()._ensureDomains(['Runtime', 'Log', 'Network']);
        await get()._applyNetworkConditions();
      } else if (panel === 'network') {
        // Lazy: Network is the flood-prone domain (main already drops
        // dataReceived). Only enabled when the user opens this panel.
        await get()._ensureDomains(['Network']);
        // Re-apply sticky cache/throttle — they reset whenever Network is
        // (re)enabled (fresh attach or post-navigation re-enable).
        await get()._applyNetworkConditions();
      } else if (panel === 'application') {
        // DOMStorage for live storage events; Network is needed for getCookies.
        await get()._ensureDomains(['DOMStorage', 'Network']);
        await get().refreshApplication();
      }
      // 'rendering' needs no panel-specific enable — its toggles target the
      // already-enabled Overlay domain + the stateless Emulation setters.
    },

    _handleNavigated: () => {
      // Main-frame navigation: the debugger survives, but the document, nodeIds,
      // and execution contexts reset (and Chromium may drop domain enablement).
      // Clear stale per-page state and re-enable the active domains against the
      // new document. Console + network are each kept iff their "Preserve log"
      // toggle is on (DevTools' behavior); DOM/styles always reset — those
      // nodeIds are meaningless on the new document. Page timing always resets.
      set({
        enabled: new Set(),
        ...(get().preserveLog ? {} : { console: [] }),
        ...(get().preserveNetworkLog ? {} : { network: [], wsFrames: new Map() }),
        // Page timing is always per-document — reset even when logs are preserved.
        navStartTime: null,
        domContentTime: null,
        loadTime: null,
        nodes: new Map(),
        childIds: new Map(),
        documentId: null,
        expanded: new Set(),
        selectedId: null,
        styles: null,
        forcedStates: new Set(),
        boxModel: null,
        searchId: null,
        searchResults: [],
        searchIndex: 0,
        searchCount: 0,
        styleSheets: new Map(),
        pendingPatch: null,
        appOrigin: null,
        localStorageItems: [],
        sessionStorageItems: [],
        cookies: [],
      });
      const epoch = get().epoch;
      void (async () => {
        await get()._ensureDomains(['Page', 'Runtime', 'Log']);
        if (get().epoch !== epoch) return;
        await get()._enablePanel(get().panel);
        if (get().epoch !== epoch) return;
        if (get().drawerOpen && get().drawerPanel !== get().panel) {
          await get()._enablePanel(get().drawerPanel);
          if (get().epoch !== epoch) return;
        }
        // Navigation clears emulation/overlay overrides — re-apply the sticky ones.
        if (hasRenderingOverrides(get().rendering)) await get()._applyRendering();
      })();
    },

    _seedConsoleErrors: async (tabId, since) => {
      // Always-on capture buffers errors in main even before the dock opens.
      // Pull them on (re)attach and prepend as exception rows so "Fix this" (and
      // the operator) sees errors that predate opening the dock.
      let errors;
      try {
        errors = await window.marudesk.invoke('devtools:pull-errors', { tabId });
      } catch {
        return; // best-effort seed
      }
      if (get().tabId !== tabId) return;
      // Only seed errors that predate the bind (`since`); newer ones arrive live
      // via the relay (with their own entry ids), so seeding them too would
      // double the row. CDP timestamps are ms-since-epoch — comparable to the
      // Date.now() boundary captured at open.
      const seeded = errors
        .filter((ev) => ev.timestamp < since)
        .map(
          (ev): ConsoleEntry => ({
            id: ev.id,
            kind: 'exception',
            args: [],
            text: ev.message,
            timestamp: ev.timestamp,
            stackTrace: ev.stack.length ? { callFrames: ev.stack } : undefined,
            url: ev.source?.url,
            lineNumber: ev.source?.lineNumber,
          }),
        );
      if (seeded.length === 0) return;
      // These predate everything captured live since open → prepend (oldest first).
      set((s) => ({ console: [...seeded, ...s.console] }));
    },

    /* ── elements ────────────────────────────────────────────────────── */

    handleDetached: (tabId, reason) => {
      if (get().tabId !== tabId) return;
      set({ session: 'detached', detachReason: reason, picking: false });
    },
  };
}
