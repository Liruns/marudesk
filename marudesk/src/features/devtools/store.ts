import { create } from 'zustand';
import { useTabsStore } from '../tabs/store';
import { useGridStore } from '../tabs/grid';
import { useSettingsStore } from '../settings/store';
import { toast } from '../../lib/toast';
import { cdpSend, cdpTry } from './cdp';
import {
  NODE_TYPE,
  type CdpNode,
  type ComputedStyleProperty,
  type ConsoleEntry,
  type ConsoleKind,
  type CssStyle,
  type NetworkEntry,
  type NodeId,
  type RemoteObject,
  type RuleMatch,
} from './types';

/**
 * The custom DevTools session store. One dock, bound to the active web tab; it
 * owns (1) the dock UI (open/side/size/panel), (2) the CDP session machine
 * idle→attaching→attached→detached, and (3) a slice per panel (Elements DOM
 * tree + styles, Console stream, Network table). Events arrive coalesced over
 * `devtools:cdp-event` and are routed here by `ingestBatch`; a `devtools:detached`
 * resets the machine (see useDevtoolsEvents).
 *
 * The dock tracks the active tab: switching to a different web tab rebinds the
 * session (`rebind`), switching to a feature tab unmounts the dock (it lives in
 * the browser stage) while the toggle stays "on" for the next web tab.
 */

export type DockSide = 'right' | 'bottom';
export type DevtoolsPanel = 'elements' | 'console' | 'network';
type Session = 'idle' | 'attaching' | 'attached' | 'detached';

type Styles = {
  inline?: CssStyle;
  matched: RuleMatch[];
  computed: ComputedStyleProperty[];
};

const DEFAULT_SIZE: Record<DockSide, number> = { right: 480, bottom: 320 };
const MIN_SIZE = 220;
const MAX_CONSOLE = 1500;
const MAX_NETWORK = 1500;

// CDP overlay box-model colours (content / padding / border / margin).
const rgba = (r: number, g: number, b: number, a: number) => ({ r, g, b, a });
const HIGHLIGHT_CONFIG = {
  showInfo: true,
  showStyles: false,
  contentColor: rgba(111, 168, 220, 0.45),
  paddingColor: rgba(147, 196, 125, 0.55),
  borderColor: rgba(255, 229, 153, 0.65),
  marginColor: rgba(246, 178, 107, 0.55),
};

type DevtoolsState = {
  // dock UI
  open: boolean;
  side: DockSide;
  size: number;
  panel: DevtoolsPanel;
  // session
  tabId: string | null;
  session: Session;
  detachReason: string | null;
  enabled: Set<string>;
  dropped: number;
  // Monotonic session generation. Bumped on every transition (open/close/rebind)
  // so an async flow whose await straddled a newer transition can detect it and
  // bail — prevents a rapid A→B→A switch from leaving a zombie debugger.
  epoch: number;
  // elements
  nodes: Map<NodeId, CdpNode>;
  childIds: Map<NodeId, NodeId[]>;
  documentId: NodeId | null;
  selectedId: NodeId | null;
  expanded: Set<NodeId>;
  styles: Styles | null;
  stylesLoading: boolean;
  picking: boolean;
  // console
  console: ConsoleEntry[];
  // network
  network: NetworkEntry[];
};

type DevtoolsActions = {
  toggle: () => void;
  reconnect: () => void;
  close: () => void;
  setPanel: (panel: DevtoolsPanel) => void;
  setSide: (side: DockSide) => void;
  setSize: (size: number) => void;
  rebindToActive: (tabId: string | null) => void;
  // elements
  selectNode: (id: NodeId) => Promise<void>;
  toggleExpand: (id: NodeId) => void;
  refreshDocument: () => Promise<void>;
  highlightNode: (id: NodeId) => void;
  hideHighlight: () => void;
  startPick: () => Promise<void>;
  stopPick: () => Promise<void>;
  inspectAt: (tabId: string, x: number, y: number) => Promise<void>;
  // console
  evaluate: (expression: string) => Promise<void>;
  clearConsole: () => void;
  getProperties: (
    objectId: string,
  ) => Promise<{ name: string; value: RemoteObject }[]>;
  // network
  clearNetwork: () => void;
  getResponseBody: (
    requestId: string,
  ) => Promise<{ body: string; base64Encoded: boolean } | null>;
  // event ingestion
  ingestBatch: (
    items: { method: string; params: unknown }[],
    dropped?: number,
  ) => void;
  handleDetached: (tabId: string, reason: string) => void;
  // internal helpers (prefixed _)
  _openFor: (tabId: string, side: DockSide) => Promise<void>;
  _ensureDomains: (domains: string[]) => Promise<void>;
  _enablePanel: (panel: DevtoolsPanel) => Promise<void>;
  _handleNavigated: () => void;
  _pushConsole: (entry: Omit<ConsoleEntry, 'id' | 'timestamp'> & { timestamp?: number }) => void;
  _finishPick: (backendNodeId: number) => Promise<void>;
  _revealAndSelect: (nodeId: NodeId) => Promise<void>;
};

function freshSlices(): Pick<
  DevtoolsState,
  | 'nodes'
  | 'childIds'
  | 'documentId'
  | 'selectedId'
  | 'expanded'
  | 'styles'
  | 'stylesLoading'
  | 'picking'
  | 'console'
  | 'network'
  | 'dropped'
> {
  return {
    nodes: new Map(),
    childIds: new Map(),
    documentId: null,
    selectedId: null,
    expanded: new Set(),
    styles: null,
    stylesLoading: false,
    picking: false,
    console: [],
    network: [],
    dropped: 0,
  };
}

/* ── DOM indexing helpers (operate on mutable containers; caller clones) ── */

function indexNode(
  node: CdpNode,
  nodes: Map<NodeId, CdpNode>,
  childIds: Map<NodeId, NodeId[]>,
): void {
  const { children, ...flat } = node;
  nodes.set(node.nodeId, flat);
  if (children) {
    childIds.set(
      node.nodeId,
      children.map((c) => c.nodeId),
    );
    for (const c of children) indexNode(c, nodes, childIds);
  } else if (node.childNodeCount === 0) {
    childIds.set(node.nodeId, []);
  }
}

function setAttr(attrs: string[] | undefined, name: string, value: string): string[] {
  const next = attrs ? [...attrs] : [];
  for (let i = 0; i < next.length; i += 2) {
    if (next[i] === name) {
      next[i + 1] = value;
      return next;
    }
  }
  next.push(name, value);
  return next;
}

function removeAttr(attrs: string[] | undefined, name: string): string[] {
  const next: string[] = [];
  if (!attrs) return next;
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] !== name) next.push(attrs[i], attrs[i + 1]);
  }
  return next;
}

function consoleKindFromApi(type: string): ConsoleKind {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
      return 'warning';
    case 'debug':
      return 'debug';
    case 'info':
      return 'info';
    default:
      return 'log';
  }
}

function consoleKindFromLog(level: string): ConsoleKind {
  switch (level) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'verbose':
      return 'debug';
    default:
      return 'info';
  }
}

let entrySeq = 0;
function entryId(): string {
  return `c${++entrySeq}`;
}

export const useDevtoolsStore = create<DevtoolsState & DevtoolsActions>(
  (set, get) => ({
    open: false,
    side: 'right',
    size: 0,
    panel: 'elements',
    tabId: null,
    session: 'idle',
    detachReason: null,
    enabled: new Set(),
    epoch: 0,
    ...freshSlices(),

    /* ── dock lifecycle ──────────────────────────────────────────────── */

    toggle: () => {
      if (useGridStore.getState().layout !== null) {
        toast({
          title: 'Exit the grid to use DevTools',
          description: 'DevTools attaches to a single page at a time.',
          variant: 'warning',
        });
        return;
      }
      const tabs = useTabsStore.getState();
      const active = tabs.tabs.find((t) => t.id === tabs.activeTabId);
      if (!active || active.kind !== 'web') return;
      const dock = useSettingsStore.getState().settings.devtools.defaultDock;
      if (dock === 'chrome') {
        void window.marudesk.invoke('devtools:open-chrome', { tabId: active.id });
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
      const tabs = useTabsStore.getState();
      const active = tabs.tabs.find((t) => t.id === tabs.activeTabId);
      if (active?.kind === 'web') void s._openFor(active.id, s.side);
    },

    _openFor: async (tabId, side) => {
      const prev = get().tabId;
      const epoch = get().epoch + 1;
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

    setPanel: (panel) => {
      if (get().panel === panel) return;
      set({ panel });
      if (get().session === 'attached') void get()._enablePanel(panel);
    },

    setSide: (side) => set({ side, size: DEFAULT_SIZE[side] }),

    setSize: (size) => set({ size: Math.max(MIN_SIZE, Math.round(size)) }),

    rebindToActive: (tabId) => {
      const s = get();
      if (!s.open) return;
      if (tabId === s.tabId) return;
      // Active tab left the web kind (feature tab) — the dock unmounts with the
      // browser stage; keep the session so returning to this tab is instant.
      if (tabId === null) return;
      const old = s.tabId;
      const epoch = s.epoch + 1;
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
      } else if (panel === 'network') {
        // Lazy: Network is the flood-prone domain (main already drops
        // dataReceived). Only enabled when the user opens this panel.
        await get()._ensureDomains(['Network']);
      }
    },

    _handleNavigated: () => {
      // Main-frame navigation: the debugger survives, but the document, nodeIds,
      // and execution contexts reset (and Chromium may drop domain enablement).
      // Clear stale per-page state — like DevTools' default (no "preserve log")
      // — and re-enable the active domains against the new document.
      set({
        enabled: new Set(),
        console: [],
        network: [],
        nodes: new Map(),
        childIds: new Map(),
        documentId: null,
        expanded: new Set(),
        selectedId: null,
        styles: null,
      });
      const epoch = get().epoch;
      void (async () => {
        await get()._ensureDomains(['Page', 'Runtime', 'Log']);
        if (get().epoch !== epoch) return;
        await get()._enablePanel(get().panel);
      })();
    },

    /* ── elements ────────────────────────────────────────────────────── */

    refreshDocument: async () => {
      const tabId = get().tabId;
      if (!tabId) return;
      const res = await cdpTry<{ root: CdpNode }>(tabId, 'DOM.getDocument', {
        depth: 3,
      });
      if (!res?.root || get().tabId !== tabId) return;
      const nodes = new Map<NodeId, CdpNode>();
      const childIds = new Map<NodeId, NodeId[]>();
      indexNode(res.root, nodes, childIds);
      const expanded = new Set<NodeId>([res.root.nodeId]);
      const docKids = childIds.get(res.root.nodeId) ?? [];
      const html = docKids
        .map((id) => nodes.get(id))
        .find((n) => n?.nodeType === NODE_TYPE.ELEMENT);
      if (html) {
        expanded.add(html.nodeId);
        const body = (childIds.get(html.nodeId) ?? [])
          .map((id) => nodes.get(id))
          .find((n) => n?.nodeName === 'BODY');
        if (body) expanded.add(body.nodeId);
      }
      set({ nodes, childIds, documentId: res.root.nodeId, expanded });
    },

    toggleExpand: (id) => {
      const expanded = new Set(get().expanded);
      if (expanded.has(id)) {
        expanded.delete(id);
        set({ expanded });
        return;
      }
      expanded.add(id);
      set({ expanded });
      if (!get().childIds.has(id)) {
        const tabId = get().tabId;
        if (tabId) void cdpTry(tabId, 'DOM.requestChildNodes', { nodeId: id, depth: 1 });
      }
    },

    selectNode: async (id) => {
      set({ selectedId: id, styles: null, stylesLoading: true });
      const tabId = get().tabId;
      if (!tabId) {
        set({ stylesLoading: false });
        return;
      }
      get().highlightNode(id);
      const [matched, computed] = await Promise.all([
        cdpTry<{ inlineStyle?: CssStyle; matchedCSSRules?: RuleMatch[] }>(
          tabId,
          'CSS.getMatchedStylesForNode',
          { nodeId: id },
        ),
        cdpTry<{ computedStyle: ComputedStyleProperty[] }>(
          tabId,
          'CSS.getComputedStyleForNode',
          { nodeId: id },
        ),
      ]);
      if (get().selectedId !== id) return; // selection moved while awaiting
      set({
        styles: {
          inline: matched?.inlineStyle,
          matched: matched?.matchedCSSRules ?? [],
          computed: computed?.computedStyle ?? [],
        },
        stylesLoading: false,
      });
    },

    highlightNode: (id) => {
      const tabId = get().tabId;
      if (!tabId) return;
      void cdpTry(tabId, 'Overlay.highlightNode', {
        highlightConfig: HIGHLIGHT_CONFIG,
        nodeId: id,
      });
    },

    hideHighlight: () => {
      const tabId = get().tabId;
      if (!tabId) return;
      void cdpTry(tabId, 'Overlay.hideHighlight');
    },

    startPick: async () => {
      const tabId = get().tabId;
      if (!tabId) return;
      await get()._ensureDomains(['DOM', 'Overlay']);
      set({ picking: true });
      await cdpTry(tabId, 'Overlay.setInspectMode', {
        mode: 'searchForNode',
        highlightConfig: HIGHLIGHT_CONFIG,
      });
    },

    stopPick: async () => {
      const tabId = get().tabId;
      set({ picking: false });
      if (tabId) {
        await cdpTry(tabId, 'Overlay.setInspectMode', {
          mode: 'none',
          highlightConfig: HIGHLIGHT_CONFIG,
        });
      }
    },

    _finishPick: async (backendNodeId) => {
      const tabId = get().tabId;
      set({ picking: false });
      if (!tabId) return;
      await cdpTry(tabId, 'Overlay.setInspectMode', {
        mode: 'none',
        highlightConfig: HIGHLIGHT_CONFIG,
      });
      const res = await cdpTry<{ nodeIds: NodeId[] }>(
        tabId,
        'DOM.pushNodesByBackendIdsToFrontend',
        { backendNodeIds: [backendNodeId] },
      );
      const nodeId = res?.nodeIds?.[0];
      if (nodeId) await get()._revealAndSelect(nodeId);
    },

    inspectAt: async (tabId, x, y) => {
      const dock = useSettingsStore.getState().settings.devtools.defaultDock;
      if (dock === 'chrome') {
        void window.marudesk.invoke('devtools:open-chrome', { tabId });
        return;
      }
      if (useGridStore.getState().layout !== null) {
        toast({ title: 'Exit the grid to use DevTools', variant: 'warning' });
        return;
      }

      // Resolve the node at the click point, then reveal it. getNodeForLocation
      // returns a layout-independent backendNodeId, so once resolved the node
      // stays valid even after the dock reflows the page.
      const resolveAndSelect = async (epoch: number) => {
        const res = await cdpTry<{ backendNodeId: number; nodeId?: NodeId }>(
          tabId,
          'DOM.getNodeForLocation',
          { x, y, includeUserAgentShadowDOM: false },
        );
        if (get().epoch !== epoch || !res) return;
        let nodeId = res.nodeId;
        if (!nodeId && res.backendNodeId) {
          const pushed = await cdpTry<{ nodeIds: NodeId[] }>(
            tabId,
            'DOM.pushNodesByBackendIdsToFrontend',
            { backendNodeIds: [res.backendNodeId] },
          );
          if (get().epoch !== epoch) return;
          nodeId = pushed?.nodeIds?.[0];
        }
        if (nodeId) await get()._revealAndSelect(nodeId);
      };

      if (get().open && get().tabId === tabId && get().session === 'attached') {
        // Dock already open here: the page is already at its docked size, so the
        // right-click coords are correct for the current viewport — resolve now.
        if (get().panel !== 'elements') {
          set({ panel: 'elements' });
          await get()._enablePanel('elements');
        }
        await resolveAndSelect(get().epoch);
        return;
      }

      // Dock was closed: attach and resolve the node WHILE the page is still
      // full-size, THEN reveal the dock (which shrinks the page). Opening first
      // would reflow the page and the cached point would hit the wrong element.
      const epoch = get().epoch + 1;
      set({
        side: dock,
        size: get().size >= MIN_SIZE ? get().size : DEFAULT_SIZE[dock],
        tabId,
        panel: 'elements',
        session: 'attaching',
        detachReason: null,
        enabled: new Set(),
        epoch,
        open: false, // not shown yet — keep the page full-size for the resolve
        ...freshSlices(),
      });
      const ok = await window.marudesk.invoke('devtools:open', { tabId });
      if (get().epoch !== epoch) return;
      if (!ok) {
        set({ session: 'idle' });
        return;
      }
      set({ session: 'attached' });
      await get()._ensureDomains([
        'Page',
        'Runtime',
        'Log',
        'DOM',
        'CSS',
        'Overlay',
      ]);
      if (get().epoch !== epoch) return;
      await get().refreshDocument();
      if (get().epoch !== epoch) return;
      await resolveAndSelect(epoch);
      if (get().epoch !== epoch) return;
      set({ open: true }); // reveal now that the node is resolved
    },

    _revealAndSelect: async (nodeId) => {
      // Expand whatever ancestors are already indexed (best-effort: the chain
      // is filled in lazily by setChildNodes events, which may still be in
      // flight — selection + styles work regardless).
      const expanded = new Set(get().expanded);
      const seen = new Set<NodeId>();
      let cur = get().nodes.get(nodeId);
      while (cur?.parentId && !seen.has(cur.parentId)) {
        seen.add(cur.parentId);
        expanded.add(cur.parentId);
        cur = get().nodes.get(cur.parentId);
      }
      set({ expanded });
      await get().selectNode(nodeId);
    },

    /* ── console ─────────────────────────────────────────────────────── */

    _pushConsole: (entry) => {
      const e: ConsoleEntry = {
        id: entryId(),
        timestamp: entry.timestamp ?? Date.now(),
        kind: entry.kind,
        args: entry.args,
        text: entry.text,
        stackTrace: entry.stackTrace,
        url: entry.url,
        lineNumber: entry.lineNumber,
      };
      const next = [...get().console, e];
      if (next.length > MAX_CONSOLE) next.splice(0, next.length - MAX_CONSOLE);
      set({ console: next });
    },

    evaluate: async (expression) => {
      const tabId = get().tabId;
      if (!tabId || !expression.trim()) return;
      await get()._ensureDomains(['Runtime']);
      get()._pushConsole({ kind: 'command', args: [], text: expression });
      try {
        const r = await cdpSend<{
          result: RemoteObject;
          exceptionDetails?: {
            text: string;
            exception?: RemoteObject;
            lineNumber?: number;
          };
        }>(tabId, 'Runtime.evaluate', {
          expression,
          objectGroup: 'console',
          includeCommandLineAPI: true,
          generatePreview: true,
          returnByValue: false,
          userGesture: true,
          awaitPromise: true,
          replMode: true,
        });
        if (r.exceptionDetails) {
          const ex = r.exceptionDetails.exception;
          get()._pushConsole({
            kind: 'exception',
            args: ex ? [ex] : [],
            text: ex ? undefined : r.exceptionDetails.text,
          });
        } else {
          get()._pushConsole({ kind: 'result', args: [r.result] });
        }
      } catch (err) {
        get()._pushConsole({
          kind: 'error',
          args: [],
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },

    clearConsole: () => set({ console: [] }),

    getProperties: async (objectId) => {
      const tabId = get().tabId;
      if (!tabId) return [];
      const res = await cdpTry<{
        result: { name: string; value?: RemoteObject; enumerable: boolean }[];
      }>(tabId, 'Runtime.getProperties', {
        objectId,
        ownProperties: true,
        generatePreview: true,
      });
      if (!res?.result) return [];
      // Own, value-bearing properties (skip accessors without a value).
      return res.result
        .filter((p) => p.value !== undefined)
        .map((p) => ({ name: p.name, value: p.value as RemoteObject }));
    },

    /* ── network ─────────────────────────────────────────────────────── */

    clearNetwork: () => set({ network: [] }),

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

    /* ── event ingestion ─────────────────────────────────────────────── */

    ingestBatch: (items, dropped) => {
      const effects: Array<() => void> = [];
      set((s) => {
        let nodes = s.nodes;
        let childIds = s.childIds;
        let domDirty = false;
        let consoleArr = s.console;
        let consoleDirty = false;
        let network = s.network;
        let netIndex: Map<string, number> | null = null;
        let netDirty = false;

        const ensureDom = () => {
          if (!domDirty) {
            nodes = new Map(nodes);
            childIds = new Map(childIds);
            domDirty = true;
          }
        };
        const ensureNet = () => {
          if (!netDirty) {
            network = [...network];
            netIndex = new Map(network.map((e, i) => [e.requestId, i]));
            netDirty = true;
          } else if (!netIndex) {
            netIndex = new Map(network.map((e, i) => [e.requestId, i]));
          }
        };
        const pushConsole = (e: ConsoleEntry) => {
          if (!consoleDirty) {
            consoleArr = [...consoleArr];
            consoleDirty = true;
          }
          consoleArr.push(e);
        };

        for (const { method, params } of items) {
          const pAny = params as Record<string, unknown>;
          switch (method) {
            /* DOM */
            case 'DOM.setChildNodes': {
              ensureDom();
              const parentId = pAny.parentId as NodeId;
              const kids = (pAny.nodes as CdpNode[]) ?? [];
              for (const k of kids) indexNode(k, nodes, childIds);
              childIds.set(
                parentId,
                kids.map((k) => k.nodeId),
              );
              break;
            }
            case 'DOM.childNodeInserted': {
              ensureDom();
              const parentId = pAny.parentNodeId as NodeId;
              const prev = pAny.previousNodeId as NodeId;
              const node = pAny.node as CdpNode;
              indexNode(node, nodes, childIds);
              const list = [...(childIds.get(parentId) ?? [])];
              const at = prev === 0 ? 0 : list.indexOf(prev) + 1;
              list.splice(at, 0, node.nodeId);
              childIds.set(parentId, list);
              break;
            }
            case 'DOM.childNodeRemoved': {
              ensureDom();
              const parentId = pAny.parentNodeId as NodeId;
              const nodeId = pAny.nodeId as NodeId;
              const list = (childIds.get(parentId) ?? []).filter((x) => x !== nodeId);
              childIds.set(parentId, list);
              nodes.delete(nodeId);
              break;
            }
            case 'DOM.attributeModified': {
              ensureDom();
              const nodeId = pAny.nodeId as NodeId;
              const node = nodes.get(nodeId);
              if (node) {
                nodes.set(nodeId, {
                  ...node,
                  attributes: setAttr(
                    node.attributes,
                    pAny.name as string,
                    pAny.value as string,
                  ),
                });
              }
              break;
            }
            case 'DOM.attributeRemoved': {
              ensureDom();
              const nodeId = pAny.nodeId as NodeId;
              const node = nodes.get(nodeId);
              if (node) {
                nodes.set(nodeId, {
                  ...node,
                  attributes: removeAttr(node.attributes, pAny.name as string),
                });
              }
              break;
            }
            case 'DOM.childNodeCountUpdated': {
              ensureDom();
              const nodeId = pAny.nodeId as NodeId;
              const node = nodes.get(nodeId);
              if (node) {
                nodes.set(nodeId, {
                  ...node,
                  childNodeCount: pAny.childNodeCount as number,
                });
              }
              break;
            }
            case 'DOM.documentUpdated': {
              // Major DOM swap (e.g. document.write) without a frame nav.
              effects.push(() => void get().refreshDocument());
              break;
            }
            case 'Page.frameNavigated': {
              // Main frame only — subframes/ad-iframes carry a parentId and must
              // not thrash the session (§11.3). Re-enable domains + clear stale
              // per-page state for the new document.
              const frame = pAny.frame as { parentId?: string } | undefined;
              if (frame && frame.parentId === undefined) {
                effects.push(() => get()._handleNavigated());
              }
              break;
            }

            /* Overlay (element picker) */
            case 'Overlay.inspectNodeRequested': {
              const backendNodeId = pAny.backendNodeId as number;
              effects.push(() => void get()._finishPick(backendNodeId));
              break;
            }

            /* Console */
            case 'Runtime.consoleAPICalled': {
              pushConsole({
                id: entryId(),
                kind: consoleKindFromApi(pAny.type as string),
                args: (pAny.args as RemoteObject[]) ?? [],
                timestamp: (pAny.timestamp as number) || Date.now(),
                stackTrace: pAny.stackTrace as ConsoleEntry['stackTrace'],
              });
              break;
            }
            case 'Runtime.exceptionThrown': {
              const det = pAny.exceptionDetails as {
                text: string;
                exception?: RemoteObject;
                lineNumber?: number;
                url?: string;
                stackTrace?: ConsoleEntry['stackTrace'];
              };
              pushConsole({
                id: entryId(),
                kind: 'exception',
                args: det.exception ? [det.exception] : [],
                text: det.exception ? undefined : det.text,
                timestamp: (pAny.timestamp as number) || Date.now(),
                stackTrace: det.stackTrace,
                url: det.url,
                lineNumber: det.lineNumber,
              });
              break;
            }
            case 'Log.entryAdded': {
              const entry = pAny.entry as {
                level: string;
                text: string;
                timestamp?: number;
                url?: string;
                lineNumber?: number;
              };
              pushConsole({
                id: entryId(),
                kind: consoleKindFromLog(entry.level),
                args: [],
                text: entry.text,
                timestamp: entry.timestamp || Date.now(),
                url: entry.url,
                lineNumber: entry.lineNumber,
              });
              break;
            }

            /* Network */
            case 'Network.requestWillBeSent': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const req = pAny.request as {
                url: string;
                method: string;
                headers: Record<string, string>;
              };
              const entry: NetworkEntry = {
                requestId,
                url: req.url,
                method: req.method,
                resourceType: pAny.type as string | undefined,
                startTime: pAny.timestamp as number,
                requestHeaders: req.headers,
              };
              const idx = netIndex!.get(requestId);
              if (idx === undefined) {
                netIndex!.set(requestId, network.length);
                network.push(entry);
              } else {
                network[idx] = { ...network[idx], ...entry };
              }
              break;
            }
            case 'Network.responseReceived': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const resp = pAny.response as {
                status: number;
                statusText: string;
                headers: Record<string, string>;
                mimeType: string;
                fromDiskCache?: boolean;
                remoteIPAddress?: string;
              };
              const idx = netIndex!.get(requestId);
              if (idx !== undefined) {
                network[idx] = {
                  ...network[idx],
                  status: resp.status,
                  statusText: resp.statusText,
                  responseHeaders: resp.headers,
                  mimeType: resp.mimeType,
                  fromCache: resp.fromDiskCache,
                  remoteIPAddress: resp.remoteIPAddress,
                  resourceType: (pAny.type as string) ?? network[idx].resourceType,
                };
              }
              break;
            }
            case 'Network.loadingFinished': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const idx = netIndex!.get(requestId);
              if (idx !== undefined) {
                network[idx] = {
                  ...network[idx],
                  endTime: pAny.timestamp as number,
                  encodedDataLength: pAny.encodedDataLength as number,
                };
              }
              break;
            }
            case 'Network.loadingFailed': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const idx = netIndex!.get(requestId);
              if (idx !== undefined) {
                network[idx] = {
                  ...network[idx],
                  endTime: pAny.timestamp as number,
                  failed: true,
                  errorText: pAny.errorText as string,
                };
              }
              break;
            }
          }
        }

        if (netDirty && network.length > MAX_NETWORK) {
          network = network.slice(network.length - MAX_NETWORK);
        }
        if (consoleDirty && consoleArr.length > MAX_CONSOLE) {
          consoleArr = consoleArr.slice(consoleArr.length - MAX_CONSOLE);
        }

        const next: Partial<DevtoolsState> = {};
        if (domDirty) {
          next.nodes = nodes;
          next.childIds = childIds;
        }
        if (consoleDirty) next.console = consoleArr;
        if (netDirty) next.network = network;
        if (dropped) next.dropped = s.dropped + dropped;
        return next;
      });
      for (const fn of effects) fn();
    },

    handleDetached: (tabId, reason) => {
      if (get().tabId !== tabId) return;
      set({ session: 'detached', detachReason: reason, picking: false });
    },
  }),
);
