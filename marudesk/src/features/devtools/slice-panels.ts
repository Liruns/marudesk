import type { StoreApi } from 'zustand';
import { toast } from '../../lib/toast';
import { cdpTry } from './cdp';
import { msg } from './store-internals';
import type {
  AppManifest,
  AppManifestError,
  CacheEntry,
  CacheInfo,
  CdpCookie,
  FrameTreeNode,
  IdbDatabase,
  IdbEntry,
  RemoteObject,
  StorageUsage,
} from './types';
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
  | 'loadIdbEntries'
  | 'deleteIdbDatabase'
  | 'loadCacheEntries'
  | 'deleteCache'
  | 'deleteCacheEntry'
  | 'setRendering'
  | '_applyRendering'
>;

// IndexedDB/CacheStorage previews are bounded reads — first page only.
const MAX_IDB_DATABASES = 20;
const MAX_IDB_ENTRIES = 50;
const MAX_CACHE_ENTRIES = 100;
// Frame-tree cap (an ad-heavy page can nest hundreds of iframes).
const MAX_FRAMES = 100;

/** `IndexedDB.KeyPath` → a display string ('' for out-of-line keys). */
function keyPathLabel(kp: { type: string; string?: string; array?: string[] } | undefined): string {
  if (!kp) return '';
  if (kp.type === 'string') return kp.string ?? '';
  if (kp.type === 'array') return `[${(kp.array ?? []).join(', ')}]`;
  return '';
}

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
      set({ network: [], navStartTime: null, domContentTime: null, loadTime: null }),

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
      // IndexedDB: database names, then each database's object-store metadata
      // (bounded). Entries are NOT read here — loadIdbEntries pulls on demand.
      const readIndexedDb = async (): Promise<IdbDatabase[]> => {
        if (!origin) return [];
        const names = await cdpTry<{ databaseNames: string[] }>(
          tabId,
          'IndexedDB.requestDatabaseNames',
          { securityOrigin: origin },
        );
        const list = (names?.databaseNames ?? []).slice(0, MAX_IDB_DATABASES);
        return Promise.all(
          list.map(async (name): Promise<IdbDatabase> => {
            const res = await cdpTry<{
              databaseWithObjectStores: {
                name: string;
                version: number;
                objectStores: {
                  name: string;
                  keyPath?: { type: string; string?: string; array?: string[] };
                  autoIncrement?: boolean;
                }[];
              };
            }>(tabId, 'IndexedDB.requestDatabase', {
              securityOrigin: origin,
              databaseName: name,
            });
            const db = res?.databaseWithObjectStores;
            if (!db) return { name, version: 0, objectStores: [] };
            return {
              name: db.name,
              version: db.version,
              objectStores: db.objectStores.map((os) => ({
                name: os.name,
                keyPath: keyPathLabel(os.keyPath),
                autoIncrement: !!os.autoIncrement,
              })),
            };
          }),
        );
      };
      const readCaches = async (): Promise<CacheInfo[]> => {
        if (!origin) return [];
        const res = await cdpTry<{ caches: CacheInfo[] }>(
          tabId,
          'CacheStorage.requestCacheNames',
          { securityOrigin: origin },
        );
        return res?.caches ?? [];
      };
      // Origin quota snapshot (Storage.getUsageAndQuota): bytes used vs granted
      // plus the per-storage-type breakdown (zero-usage types are noise).
      const readQuota = async (): Promise<StorageUsage | null> => {
        if (!origin) return null;
        const res = await cdpTry<{
          usage: number;
          quota: number;
          usageBreakdown?: { storageType: string; usage: number }[];
        }>(tabId, 'Storage.getUsageAndQuota', { origin });
        if (!res) return null;
        return {
          usage: res.usage,
          quota: res.quota,
          breakdown: (res.usageBreakdown ?? []).filter((b) => b.usage > 0),
        };
      };
      // Web-app manifest. `url` is '' when the page declares none.
      const readManifest = async (): Promise<AppManifest | null> => {
        const res = await cdpTry<{
          url: string;
          errors?: AppManifestError[];
          data?: string;
        }>(tabId, 'Page.getAppManifest');
        if (!res) return null;
        return { url: res.url, errors: res.errors ?? [], data: res.data };
      };
      // The page's frame tree, flattened with depth for indented rendering.
      const readFrames = async (): Promise<FrameTreeNode[]> => {
        type CdpFrameTree = {
          frame: { id: string; url: string; name?: string; mimeType?: string };
          childFrames?: CdpFrameTree[];
        };
        const res = await cdpTry<{ frameTree: CdpFrameTree }>(
          tabId,
          'Page.getFrameTree',
        );
        if (!res?.frameTree) return [];
        const out: FrameTreeNode[] = [];
        const walk = (node: CdpFrameTree, depth: number) => {
          if (out.length >= MAX_FRAMES) return;
          out.push({
            id: node.frame.id,
            url: node.frame.url,
            name: node.frame.name,
            mimeType: node.frame.mimeType,
            depth,
          });
          for (const child of node.childFrames ?? []) walk(child, depth + 1);
        };
        walk(res.frameTree, 0);
        return out;
      };
      const [
        local,
        sessionItems,
        cookieRes,
        idbDatabases,
        cacheNames,
        storageUsage,
        appManifest,
        frameTree,
      ] = await Promise.all([
        readStorage(true),
        readStorage(false),
        cdpTry<{ cookies: CdpCookie[] }>(tabId, 'Network.getCookies', {
          urls: origin ? [origin] : undefined,
        }),
        readIndexedDb(),
        readCaches(),
        readQuota(),
        readManifest(),
        readFrames(),
      ]);
      if (get().tabId !== tabId) return;
      set({
        appOrigin: origin,
        localStorageItems: local,
        sessionStorageItems: sessionItems,
        cookies: cookieRes?.cookies ?? [],
        idbDatabases,
        cacheNames,
        storageUsage,
        appManifest,
        frameTree,
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

    /* ── application: IndexedDB + Cache Storage (read + scoped delete) ── */

    loadIdbEntries: async (databaseName, objectStoreName) => {
      const tabId = get().tabId;
      const origin = get().appOrigin;
      if (!tabId || !origin) return [];
      const res = await cdpTry<{ objectStoreDataEntries: IdbEntry[] }>(
        tabId,
        'IndexedDB.requestData',
        {
          securityOrigin: origin,
          databaseName,
          objectStoreName,
          indexName: '',
          skipCount: 0,
          pageSize: MAX_IDB_ENTRIES,
        },
      );
      return res?.objectStoreDataEntries ?? [];
    },

    deleteIdbDatabase: async (databaseName) => {
      const tabId = get().tabId;
      const origin = get().appOrigin;
      if (!tabId || !origin) return;
      await cdpTry(tabId, 'IndexedDB.deleteDatabase', {
        securityOrigin: origin,
        databaseName,
      });
      if (get().tabId !== tabId) return;
      await get().refreshApplication();
    },

    loadCacheEntries: async (cacheId) => {
      const tabId = get().tabId;
      if (!tabId) return [];
      const res = await cdpTry<{ cacheDataEntries: CacheEntry[] }>(
        tabId,
        'CacheStorage.requestEntries',
        { cacheId, skipCount: 0, pageSize: MAX_CACHE_ENTRIES },
      );
      return res?.cacheDataEntries ?? [];
    },

    deleteCache: async (cacheId) => {
      const tabId = get().tabId;
      if (!tabId) return;
      await cdpTry(tabId, 'CacheStorage.deleteCache', { cacheId });
      if (get().tabId !== tabId) return;
      await get().refreshApplication();
    },

    deleteCacheEntry: async (cacheId, requestURL) => {
      const tabId = get().tabId;
      if (!tabId) return;
      await cdpTry(tabId, 'CacheStorage.deleteEntry', {
        cacheId,
        request: requestURL,
      });
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
