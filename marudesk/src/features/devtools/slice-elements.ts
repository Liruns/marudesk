import type { StoreApi } from 'zustand';
import { useTabsStore } from '../tabs/store';
import { useGridStore, groupForTab } from '../tabs/grid';
import { useSettingsStore } from '../settings/store';
import { useWebPageStore } from '../browser/store';
import { toast } from '../../lib/toast';
import { humanizeError } from '../../lib/humanizeError';
import { cdpSend, cdpTry } from './cdp';
import { buildCapture } from './capture';
import { computeBlockEdit, rebuildStyleText, resolveStyleSheetSource } from './css-source';
import { indexNode } from './dom-index';
import {
  msg,
  freshSlices,
  HIGHLIGHT_CONFIG,
  DEFAULT_SIZE,
  MIN_SIZE,
} from './store-internals';
import {
  NODE_TYPE,
  type BoxModel,
  type CdpNode,
  type ComputedStyleProperty,
  type CssStyle,
  type NodeId,
  type RuleMatch,
} from './types';
import type { PatchOp, PatchPreview } from '../../../shared/patch';
import type { DevtoolsState, DevtoolsActions } from './store';

type DevtoolsStore = DevtoolsState & DevtoolsActions;
type SetState = StoreApi<DevtoolsStore>['setState'];
type GetState = StoreApi<DevtoolsStore>['getState'];

type ElementsActions = Pick<
  DevtoolsActions,
  | 'refreshDocument'
  | 'toggleExpand'
  | 'selectNode'
  | 'highlightNode'
  | 'hideHighlight'
  | 'startPick'
  | 'stopPick'
  | '_finishPick'
  | 'inspectAt'
  | '_revealAndSelect'
  | '_offerSourcePatch'
  | 'captureSelected'
  | 'toggleForcedState'
  | 'searchDom'
  | 'stepSearch'
  | 'clearSearch'
  | 'editStyleProperty'
  | 'setAttribute'
  | 'applySourcePatch'
  | 'dismissSourcePatch'
>;

/**
 * The Elements/DOM panel actions for the devtools store: document refresh, tree
 * expand/select, node highlight + element picking, capture, forced pseudo-states,
 * DOM search, and the live CSS/attribute edits (with the workspace source-patch
 * hook). Extracted from store.ts as a slice creator; behavior is identical, with
 * `set`/`get` passed in. Sibling actions are reached via `get()`.
 */
export function createElementsSlice(set: SetState, get: GetState): ElementsActions {
  return {
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
      const prev = get().selectedId;
      const tabId = get().tabId;
      // Forced pseudo-classes are per-node: clear them on the node we're leaving
      // so a stale :hover doesn't linger after the user moves on.
      if (tabId && prev !== null && prev !== id && get().forcedStates.size > 0) {
        void cdpTry(tabId, 'CSS.forcePseudoState', {
          nodeId: prev,
          forcedPseudoClasses: [],
        });
      }
      set({ selectedId: id, styles: null, stylesLoading: true, forcedStates: new Set(), boxModel: null });
      if (!tabId) {
        set({ stylesLoading: false });
        return;
      }
      get().highlightNode(id);
      const [matched, computed, box] = await Promise.all([
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
        cdpTry<{ model: BoxModel }>(tabId, 'DOM.getBoxModel', { nodeId: id }),
      ]);
      if (get().selectedId !== id) return; // selection moved while awaiting
      set({
        styles: {
          inline: matched?.inlineStyle,
          matched: matched?.matchedCSSRules ?? [],
          computed: computed?.computedStyle ?? [],
        },
        boxModel: box?.model ?? null,
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
      if (groupForTab(useGridStore.getState().groups, useTabsStore.getState().activeTabId) !== null) {
        toast({ title: msg('devtools.toast.exitGrid'), variant: 'warning' });
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

    captureSelected: async () => {
      const { tabId, selectedId, nodes, styles } = get();
      const node = selectedId !== null ? nodes.get(selectedId) : undefined;
      if (!tabId || selectedId === null || !node || node.nodeType !== NODE_TYPE.ELEMENT) {
        toast({ title: msg('devtools.toast.selectElementFirst'), variant: 'warning' });
        return;
      }
      // Reuse the computed style the Elements panel already loaded for the
      // selection (no extra round-trip); buildCapture only fetches outerHTML +
      // box model. url comes from the bound web tab's address bar.
      const url = useWebPageStore.getState().currentUrl;
      const capture = await buildCapture(
        tabId,
        selectedId,
        node,
        nodes,
        styles?.computed ?? [],
        url,
      );
      if (get().tabId !== tabId) return; // navigated / rebound while assembling
      useWebPageStore.getState().addCapture(capture);
      toast({
        title: msg('devtools.toast.addedToContext'),
        description: capture.selector || capture.tagName,
        variant: 'success',
      });
    },

    toggleForcedState: async (pseudoClass) => {
      const tabId = get().tabId;
      const nodeId = get().selectedId;
      if (!tabId || nodeId === null) return;
      const next = new Set(get().forcedStates);
      if (next.has(pseudoClass)) next.delete(pseudoClass);
      else next.add(pseudoClass);
      set({ forcedStates: next });
      await cdpTry(tabId, 'CSS.forcePseudoState', {
        nodeId,
        forcedPseudoClasses: [...next],
      });
      if (get().selectedId !== nodeId) return; // moved while awaiting
      // Re-read styles so rules gated on the now-forced state appear/disappear.
      await get().selectNode(nodeId);
    },

    searchDom: async (query) => {
      const tabId = get().tabId;
      if (!tabId) return;
      get().clearSearch();
      const q = query.trim();
      if (!q) return;
      await get()._ensureDomains(['DOM']);
      const res = await cdpTry<{ searchId: string; resultCount: number }>(
        tabId,
        'DOM.performSearch',
        { query: q, includeUserAgentShadowDOM: false },
      );
      if (!res || get().tabId !== tabId) {
        if (res) void cdpTry(tabId, 'DOM.discardSearchResults', { searchId: res.searchId });
        return;
      }
      if (res.resultCount === 0) {
        set({ searchId: res.searchId, searchResults: [], searchIndex: 0, searchCount: 0 });
        return;
      }
      const got = await cdpTry<{ nodeIds: NodeId[] }>(tabId, 'DOM.getSearchResults', {
        searchId: res.searchId,
        fromIndex: 0,
        toIndex: res.resultCount,
      });
      if (get().tabId !== tabId) {
        void cdpTry(tabId, 'DOM.discardSearchResults', { searchId: res.searchId });
        return;
      }
      const nodeIds = got?.nodeIds ?? [];
      set({
        searchId: res.searchId,
        searchResults: nodeIds,
        searchCount: res.resultCount,
        searchIndex: 0,
      });
      if (nodeIds[0] !== undefined) await get()._revealAndSelect(nodeIds[0]);
    },

    stepSearch: async (delta) => {
      const { searchResults, searchIndex } = get();
      if (searchResults.length === 0) return;
      const n = searchResults.length;
      const next = ((searchIndex + delta) % n + n) % n;
      set({ searchIndex: next });
      const nodeId = searchResults[next];
      if (nodeId !== undefined) await get()._revealAndSelect(nodeId);
    },

    clearSearch: () => {
      const tabId = get().tabId;
      const searchId = get().searchId;
      if (tabId && searchId) {
        void cdpTry(tabId, 'DOM.discardSearchResults', { searchId });
      }
      set({ searchId: null, searchResults: [], searchIndex: 0, searchCount: 0 });
    },

    /* ── live edit (CSS / attributes) + source-patch hook ─────────────── */

    editStyleProperty: async (style, propIndex, newValue) => {
      const tabId = get().tabId;
      const selId = get().selectedId;
      if (!tabId || selId === null) return;
      const styleSheetId = style.styleSheetId;
      const blockRange = style.range;
      if (!styleSheetId || !blockRange) {
        toast({ title: msg('devtools.toast.ruleReadOnly'), variant: 'warning' });
        return;
      }
      const prop = style.cssProperties[propIndex];
      if (!prop || !prop.name) return;
      const value = newValue.trim().replace(/;+$/, '').trim();
      if (!value || value === prop.value) return; // empty / no-op

      // Ground truth = the served stylesheet text: enables a precise,
      // formatting-preserving splice used for BOTH the live `setStyleTexts` and
      // (hook B) the source patch's oldString. Falls back to a deterministic
      // block rebuild when ranges are unavailable.
      const sheet = await cdpTry<{ text: string }>(tabId, 'CSS.getStyleSheetText', {
        styleSheetId,
      });
      if (get().selectedId !== selId) return;
      const edit =
        sheet?.text !== undefined
          ? computeBlockEdit(sheet.text, blockRange, prop, value)
          : null;
      const newBlockText = edit?.newBlock ?? rebuildStyleText(style, propIndex, value);

      try {
        await cdpSend(tabId, 'CSS.setStyleTexts', {
          edits: [{ styleSheetId, range: blockRange, text: newBlockText }],
        });
      } catch (err) {
        toast({ title: msg('devtools.toast.editRejected'), description: humanizeError(err), variant: 'error' });
        return;
      }
      // The edit landed on the captured tab, but a rebind/nav during the
      // round-trip would make selId a stale nodeId on the new document — don't
      // refresh/offer against it.
      if (get().tabId !== tabId || get().selectedId !== selId) return;
      await get().selectNode(selId); // ranges/values shift after an edit
      // Hook B: map the edit to a workspace file, or clear to live-only. Note
      // `oldBlock` is the served text BEFORE this edit, which equals the file
      // only for the first edit of a block; a 2nd edit before "Save to source"
      // won't match disk and degrades to live-only (§19) — save between edits.
      if (edit) void get()._offerSourcePatch(styleSheetId, edit.oldBlock, edit.newBlock);
      else set({ pendingPatch: null });
    },

    setAttribute: async (nodeId, name, value) => {
      const tabId = get().tabId;
      if (!tabId) return;
      try {
        // The resulting DOM.attributeModified event updates the tree (ingestBatch).
        await cdpSend(tabId, 'DOM.setAttributeValue', { nodeId, name, value });
      } catch (err) {
        toast({
          title: msg('devtools.toast.attributeRejected'),
          description: humanizeError(err),
          variant: 'error',
        });
      }
    },

    _offerSourcePatch: async (styleSheetId, oldBlock, newBlock) => {
      const tabId = get().tabId;
      const selId = get().selectedId;
      const header = get().styleSheets.get(styleSheetId);
      if (!header) {
        set({ pendingPatch: null });
        return;
      }
      let docOrigin = '';
      try {
        docOrigin = new URL(useWebPageStore.getState().currentUrl).origin;
      } catch {
        /* no usable origin → no source mapping */
      }
      const rel = resolveStyleSheetSource(header, docOrigin);
      if (!rel) {
        set({ pendingPatch: null });
        return;
      }
      // Delegate the real feasibility check to patch:preview — it resolves the
      // path fs-safely, confirms the file exists, and that oldBlock matches
      // uniquely. Any failure → live-only (no offer).
      const op: PatchOp = { path: rel, oldString: oldBlock, newString: newBlock };
      let preview: PatchPreview;
      try {
        preview = await window.marudesk.invoke('patch:preview', [op]);
      } catch {
        set({ pendingPatch: null });
        return;
      }
      // tab/selection moved while previewing — drop a now-irrelevant offer
      // (guards against a cross-tab "Save to source" after a rebind).
      if (get().tabId !== tabId || get().selectedId !== selId) return;
      const first = preview.ops[0];
      if (preview.hasErrors || !first || first.kind !== 'edit') {
        set({ pendingPatch: null });
        return;
      }
      set({ pendingPatch: { path: rel, startLine: first.startLine, op } });
    },

    applySourcePatch: async () => {
      const pending = get().pendingPatch;
      if (!pending) return;
      try {
        const res = await window.marudesk.invoke('patch:apply', [pending.op]);
        if (res.ok) {
          toast({ title: msg('devtools.toast.savedToSource'), description: pending.path, variant: 'success' });
        } else {
          toast({
            title: msg('devtools.toast.saveFailed'),
            description: res.errors[0]?.reason ?? 'unknown error',
            variant: 'error',
          });
        }
      } catch (err) {
        toast({ title: msg('devtools.toast.saveFailed'), description: humanizeError(err), variant: 'error' });
      }
      set({ pendingPatch: null });
    },

    dismissSourcePatch: () => set({ pendingPatch: null }),
  };
}
