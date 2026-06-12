import type { StoreApi } from 'zustand';
import { toast } from '../../lib/toast';
import { cdpTry } from './cdp';
import { msg } from './store-internals';
import type { CdpCookie, RemoteObject } from './types';
import type { DevtoolsState, DevtoolsActions, ThrottlePreset } from './store';

type DevtoolsStore = DevtoolsState & DevtoolsActions;
type SetState = StoreApi<DevtoolsStore>['setState'];
type GetState = StoreApi<DevtoolsStore>['getState'];

/** Network throttling presets (Network.emulateNetworkConditions params). */
const THROTTLE_CONDITIONS: Record<
  Exclude<ThrottlePreset, 'online'>,
  { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }
> = {
  // Bandwidth in bytes/s, latency in ms — Chrome DevTools' canonical presets.
  fast3g: {
    offline: false,
    latency: 562.5,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  },
  slow3g: {
    offline: false,
    latency: 2000,
    downloadThroughput: (500 * 1024) / 8,
    uploadThroughput: (500 * 1024) / 8,
  },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
};

type PanelsActions = Pick<
  DevtoolsActions,
  | 'clearNetwork'
  | 'setPreserveNetworkLog'
  | 'getResponseBody'
  | 'setCacheDisabled'
  | 'setThrottle'
  | '_applyNetworkConditions'
  | 'refreshApplication'
  | 'removeStorageItem'
  | 'setStorageItem'
  | 'clearStorage'
  | 'deleteCookie'
  | 'clearSiteData'
  | 'setRendering'
  | '_applyRendering'
>;

/**
 * The Network / Application(storage) / Rendering panel actions for the devtools
 * store: network log clear + preserve + response-body fetch + cache-disable +
 * throttling, web-storage/cookie read+mutate + clear-site-data, and the sticky
 * rendering overrides. Extracted from store.ts as a slice creator; behavior is
 * identical, with `set`/`get` passed in.
 */
export function createPanelsSlice(set: SetState, get: GetState): PanelsActions {
  return {
    clearNetwork: () =>
      set({
        network: [],
        wsFrames: new Map(),
        navStartTime: null,
        domContentTime: null,
        loadTime: null,
      }),

    setPreserveNetworkLog: (on) => set({ preserveNetworkLog: on }),

    getResponseBody: async (requestId) => {
      const tabId = get().tabId;
      if (!tabId) return null;
      const res = await cdpTry<{ body: string; base64Encoded: boolean }>(
        tabId,
        'Network.getResponseBody',
        { requestId },
      );
      return res ?? null;
    },

    setCacheDisabled: (on) => {
      set({ cacheDisabled: on });
      void get()._applyNetworkConditions();
    },

    setThrottle: (preset) => {
      set({ throttle: preset });
      void get()._applyNetworkConditions();
    },

    _applyNetworkConditions: async () => {
      const tabId = get().tabId;
      if (!tabId || !get().enabled.has('Network')) return;
      const { cacheDisabled, throttle } = get();
      await cdpTry(tabId, 'Network.setCacheDisabled', { cacheDisabled });
      const cond =
        throttle === 'online'
          ? { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
          : THROTTLE_CONDITIONS[throttle];
      await cdpTry(tabId, 'Network.emulateNetworkConditions', cond);
    },

    /* ── application (storage) ───────────────────────────────────────── */

    refreshApplication: async () => {
      const tabId = get().tabId;
      if (!tabId) return;
      set({ appLoading: true });
      // Resolve the page's own origin (storageId key + cookie scope). Runtime is
      // enabled from session start; a non-http origin (about:blank) yields "null".
      const originRes = await cdpTry<{ result: RemoteObject }>(tabId, 'Runtime.evaluate', {
        expression: 'location.origin',
        returnByValue: true,
      });
      if (get().tabId !== tabId) return;
      const origin =
        typeof originRes?.result?.value === 'string' &&
        originRes.result.value !== 'null'
          ? originRes.result.value
          : null;

      const readStorage = async (isLocalStorage: boolean) => {
        if (!origin) return [] as [string, string][];
        const res = await cdpTry<{ entries: [string, string][] }>(
          tabId,
          'DOMStorage.getDOMStorageItems',
          { storageId: { securityOrigin: origin, isLocalStorage } },
        );
        return res?.entries ?? [];
      };
      const [local, sessionItems, cookieRes] = await Promise.all([
        readStorage(true),
        readStorage(false),
        cdpTry<{ cookies: CdpCookie[] }>(tabId, 'Network.getCookies', {
          urls: origin ? [origin] : undefined,
        }),
      ]);
      if (get().tabId !== tabId) return;
      set({
        appOrigin: origin,
        localStorageItems: local,
        sessionStorageItems: sessionItems,
        cookies: cookieRes?.cookies ?? [],
        appLoading: false,
      });
    },

    removeStorageItem: async (isLocalStorage, key) => {
      const tabId = get().tabId;
      const origin = get().appOrigin;
      if (!tabId || !origin) return;
      await cdpTry(tabId, 'DOMStorage.removeDOMStorageItem', {
        storageId: { securityOrigin: origin, isLocalStorage },
        key,
      });
      if (get().tabId !== tabId) return;
      // Optimistic local prune (the DOMStorage event may also arrive, but the
      // panel doesn't subscribe to per-key events — re-read is the source).
      const field = isLocalStorage ? 'localStorageItems' : 'sessionStorageItems';
      set({ [field]: get()[field].filter(([k]) => k !== key) } as Partial<DevtoolsState>);
    },

    setStorageItem: async (isLocalStorage, key, value) => {
      const tabId = get().tabId;
      const origin = get().appOrigin;
      if (!tabId || !origin || !key) return;
      await cdpTry(tabId, 'DOMStorage.setDOMStorageItem', {
        storageId: { securityOrigin: origin, isLocalStorage },
        key,
        value,
      });
      if (get().tabId !== tabId) return;
      // Re-read rather than patch locally: the page may normalize/reject the
      // write (quota), and refresh keeps ordering identical to the real store.
      await get().refreshApplication();
    },

    clearStorage: async (isLocalStorage) => {
      const tabId = get().tabId;
      const origin = get().appOrigin;
      if (!tabId || !origin) return;
      await cdpTry(tabId, 'DOMStorage.clear', {
        storageId: { securityOrigin: origin, isLocalStorage },
      });
      if (get().tabId !== tabId) return;
      set(
        isLocalStorage ? { localStorageItems: [] } : { sessionStorageItems: [] },
      );
    },

    deleteCookie: async (cookie) => {
      const tabId = get().tabId;
      if (!tabId) return;
      // Name+domain+path scoped — never a whole-browser clear (those CDP
      // methods stay blocked by the relay allowlist).
      await cdpTry(tabId, 'Network.deleteCookies', {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      });
      if (get().tabId !== tabId) return;
      await get().refreshApplication();
    },

    clearSiteData: async () => {
      const tabId = get().tabId;
      const origin = get().appOrigin;
      if (!tabId || !origin) {
        toast({ title: msg('devtools.toast.noOrigin'), variant: 'warning' });
        return;
      }
      // Deliberate, origin-scoped wipe (not the whole-browser Storage.clearCookies,
      // which stays blocked). Clears cookies + all storage buckets for this origin.
      await cdpTry(tabId, 'Storage.clearDataForOrigin', {
        origin,
        storageTypes: 'all',
      });
      if (get().tabId !== tabId) return;
      toast({ title: msg('devtools.toast.siteDataCleared'), description: origin, variant: 'success' });
      await get().refreshApplication();
    },

    /* ── rendering ───────────────────────────────────────────────────── */

    setRendering: (patch) => {
      set({ rendering: { ...get().rendering, ...patch } });
      void get()._applyRendering();
    },

    _applyRendering: async () => {
      const tabId = get().tabId;
      if (!tabId) return;
      // The Overlay flags need the Overlay domain; Emulation is stateless. Enable
      // Overlay here so the Rendering panel works without first opening Elements.
      await get()._ensureDomains(['Overlay']);
      if (get().tabId !== tabId) return;
      const r = get().rendering;
      await Promise.all([
        cdpTry(tabId, 'Overlay.setShowPaintRects', { result: r.paintRects }),
        cdpTry(tabId, 'Overlay.setShowLayoutShiftRegions', { result: r.layoutShiftRegions }),
        cdpTry(tabId, 'Overlay.setShowFPSCounter', { show: r.fpsCounter }),
        cdpTry(tabId, 'Overlay.setShowScrollBottleneckRects', { show: r.scrollBottleneck }),
        cdpTry(tabId, 'Overlay.setShowWebVitals', { show: r.webVitals }),
        cdpTry(tabId, 'Emulation.setEmulatedVisionDeficiency', {
          type: r.visionDeficiency,
        }),
      ]);
      // Emulated media: 'print' overrides the media type; the feature list drives
      // prefers-color-scheme / prefers-reduced-motion (empty value = no override).
      const features: { name: string; value: string }[] = [];
      if (r.colorScheme !== 'no-override') {
        features.push({ name: 'prefers-color-scheme', value: r.colorScheme });
      }
      if (r.reducedMotion) {
        features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
      }
      await cdpTry(tabId, 'Emulation.setEmulatedMedia', {
        media: r.printMedia ? 'print' : '',
        features,
      });
    },

    /* ── event ingestion ─────────────────────────────────────────────── */
  };
}
