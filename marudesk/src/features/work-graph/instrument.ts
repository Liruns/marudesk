import { create } from 'zustand';
import type { TabKind } from '../../../shared/browser';
import type { WorkspaceId } from '../../../shared/workspace';
import { confirmCloseTab, useEditorStore, type EditorFileInput } from '../editor/store';
import { useTabsStore } from '../tabs/store';
import type { SplitDir } from '../tabs/layout';

/**
 * The instrument a Task has summoned into Mission Control's main area
 * (docs/mission-control-redesign.md, Phase 2c). A Task's Resource opens here as a
 * real tool surface (browser / Monaco / terminal) hosted via the tab registry —
 * the live `WebContentsView` paints over the main rect, so the runtime-aware
 * browser gets full real estate ("zoom into the node, the instrument fills the
 * frame"). `null` = no instrument; the graph is the home.
 *
 * The instrument owns exactly ONE tab at a time and is the source of truth for
 * its lifecycle: opening a new one (or closing back to the graph) CLOSES the
 * previous tab so the main process tears down its WebContentsView. Without this
 * the native web view would keep painting over the graph after "← Graph" — there
 * is no other tab switch to hide it (clearBrowserPaneBounds re-reveals whatever
 * tab is still active in main).
 */
type InstrumentState = {
  tabId: string | null;
  kind: TabKind | null;
  /**
   * The SECOND pane of a side-by-side split (the primary is `tabId`/`kind`); null
   * when the stage hosts a single tool. A first slice of the retired canvas's
   * "see two live tools at once" — editor | Preview, AI Chat | terminal, etc. Each
   * web pane self-reports its rect (BrowserCanvas's per-pane bounds source), so two
   * native WebContentsViews tile their panes via the existing browser:set-pane-bounds
   * pipeline with no main-process change.
   */
  secondaryTabId: string | null;
  secondaryKind: TabKind | null;
  /** 'row' = side by side (primary | secondary); 'col' = stacked. */
  splitDir: SplitDir;
  /** Fraction of the split given to the PRIMARY pane (0.1–0.9). */
  splitRatio: number;
  /**
   * The coexisting Workbench layout (the tool docks BESIDE the canvas, not over
   * it). `canvasRatio` is the canvas fraction of the main row (0.2–0.85, the rest
   * is the tools); persisted. `maximized` hides the canvas for a tool-focus mode.
   */
  canvasRatio: number;
  maximized: boolean;
  setCanvasRatio: (r: number) => void;
  setMaximized: (v: boolean) => void;
  /**
   * Adopt `tabId` as the active instrument (single pane — collapses any split).
   * Returns `true` when adopted, and `false` when the switch was cancelled at the
   * dirty-editor prompt (prev is kept). Callers that created `tabId` in main BEFORE
   * calling open() MUST close it on a `false` return — otherwise the just-created
   * tab leaks as a hidden orphan whose live WebContentsView can never be torn down.
   */
  open: (tabId: string, kind: TabKind) => boolean;
  /**
   * Feature `tabId` as the active tool WITHOUT closing the previously-featured one
   * — the Workbench is a TAB STRIP: every tool you open stays alive so you can
   * switch between them. Activates the tab (so main paints its view) and collapses
   * any split to a single pane; the old primary/secondary stay open as their own
   * strip tabs (not torn down). This is the canonical "open a tool" path now;
   * {@link open} (replace-and-close) is retained only for its unit contract.
   */
  feature: (tabId: string, kind: TabKind) => void;
  /** Open `tabId` as a second pane beside the primary (a side-by-side split). */
  splitWith: (tabId: string, kind: TabKind, dir?: SplitDir) => void;
  /** Close the second pane (closes its tab) — back to the single primary tool. */
  closeSplit: () => void;
  /** Set the split ratio (clamped 0.1–0.9). */
  setSplitRatio: (ratio: number) => void;
  close: () => void;
};

function closeTabSafely(id: string | null): void {
  if (id) void useTabsStore.getState().closeTab(id);
}

/** Persisted CANVAS fraction of the coexisting workbench split (rest = the tools). */
const CANVAS_RATIO_KEY = 'marudesk.workbench.canvasRatio';
const RATIO_MIN = 0.2;
const RATIO_MAX = 0.85;
// Default canvas fraction when a tool first docks beside a populated graph. The
// user opened the tool to work IN it, so the tool is the focus (≈60%) and the
// graph stays a readable companion (≈40%) — not an even 50/50 that cramps both.
const CANVAS_RATIO_DEFAULT = 0.4;
function loadCanvasRatio(): number {
  try {
    const v = Number(localStorage.getItem(CANVAS_RATIO_KEY));
    return Number.isFinite(v) && v >= RATIO_MIN && v <= RATIO_MAX ? v : CANVAS_RATIO_DEFAULT;
  } catch {
    return CANVAS_RATIO_DEFAULT;
  }
}

export const useInstrumentStore = create<InstrumentState>((set, get) => ({
  tabId: null,
  kind: null,
  secondaryTabId: null,
  secondaryKind: null,
  splitDir: 'row',
  splitRatio: 0.5,
  canvasRatio: loadCanvasRatio(),
  maximized: false,
  setCanvasRatio: (r) => {
    const clamped = Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
    try {
      localStorage.setItem(CANVAS_RATIO_KEY, String(clamped));
    } catch {
      // ignore — the in-memory ratio still applies
    }
    set({ canvasRatio: clamped });
  },
  setMaximized: (v) => set({ maximized: v }),
  open: (tabId, kind) => {
    // A fresh single open replaces the whole stage — tear down a second pane's tab
    // first (its dirty-editor guard runs in closeSplit's spirit; a secondary editor
    // is rare, but honor the prompt).
    const sec = get().secondaryTabId;
    if (sec && sec !== tabId) {
      const secTab = useTabsStore.getState().tabs.find((t) => t.id === sec);
      if (!confirmCloseTab(secTab)) return false;
    }
    const prev = get().tabId;
    if (prev && prev !== tabId) {
      // Switching away from the previous instrument must tear down its native
      // view, so we close that tab first. Honor the dirty-editor prompt the same
      // way close() does: if the user CANCELS (keeps the dirty editor), abort the
      // switch entirely — staying on the instrument. Proceeding would leave the
      // previous tab's live WebContentsView orphaned (untracked by the store, so
      // it can no longer be torn down and keeps painting over the new instrument).
      const tab = useTabsStore.getState().tabs.find((t) => t.id === prev);
      if (!confirmCloseTab(tab)) {
        // Cancelled: stay on the previous instrument. The caller already
        // created/activated `tabId` in main before calling open(), so re-activate
        // `prev` to keep the live view in sync with the (unchanged) instrument
        // store — otherwise main would paint the abandoned tab over the kept one.
        // Returning `false` lets the caller tear down its freshly-created tab so
        // it doesn't survive as an orphan (close() lives in the CREATE callers,
        // not here: open() must not close a pre-existing tab like TabPalette's).
        void useTabsStore.getState().activateTab(prev);
        return false;
      }
      void useTabsStore.getState().closeTab(prev);
    }
    // Collapse any split — tear down the second pane's tab (its prompt passed above).
    if (sec && sec !== tabId) closeTabSafely(sec);
    set({ tabId, kind, secondaryTabId: null, secondaryKind: null });
    return true;
  },
  feature: (tabId, kind) => {
    void useTabsStore.getState().activateTab(tabId);
    set({ tabId, kind, secondaryTabId: null, secondaryKind: null });
  },
  splitWith: (tabId, kind, dir = 'row') => {
    const s = get();
    // "Split the current tool" — needs a primary, and never tiles a tab with itself.
    if (!s.tabId || s.tabId === tabId) return;
    if (s.secondaryTabId && s.secondaryTabId !== tabId) {
      const secTab = useTabsStore.getState().tabs.find((t) => t.id === s.secondaryTabId);
      if (!confirmCloseTab(secTab)) return; // keep the current split if a dirty editor cancels
      closeTabSafely(s.secondaryTabId);
    }
    set({ secondaryTabId: tabId, secondaryKind: kind, splitDir: dir, splitRatio: 0.5 });
  },
  closeSplit: () => {
    const sec = get().secondaryTabId;
    if (!sec) return;
    const secTab = useTabsStore.getState().tabs.find((t) => t.id === sec);
    if (!confirmCloseTab(secTab)) return;
    closeTabSafely(sec);
    set({ secondaryTabId: null, secondaryKind: null });
  },
  setSplitRatio: (ratio) => set({ splitRatio: Math.min(0.9, Math.max(0.1, ratio)) }),
  close: () => {
    // "← Graph" exits the WHOLE Workbench back to the pure canvas, so it closes
    // every open tool tab in the featured tab's workspace (per-tab × closes just
    // one). All dirty-editor prompts must pass before anything is torn down.
    const { tabId, secondaryTabId } = get();
    const tabsState = useTabsStore.getState();
    const featured = tabsState.tabs.find((t) => t.id === tabId);
    const victims = featured
      ? tabsState.tabs.filter((t) => t.workspaceId === featured.workspaceId)
      : tabsState.tabs.filter((t) => t.id === tabId || t.id === secondaryTabId);
    for (const v of victims) {
      if (!confirmCloseTab(v)) return; // a dirty editor cancelled — keep everything
    }
    for (const v of victims) closeTabSafely(v.id);
    // Drop focus mode so the next tool opens coexisting beside the canvas again.
    set({ tabId: null, kind: null, secondaryTabId: null, secondaryKind: null, maximized: false });
  },
}));

// If an instrument's tab is closed from elsewhere (e.g. Ctrl/Cmd+W while it is the
// active tab), drop the dangling reference so the Shell returns to the graph
// instead of rendering blank instrument chrome over an already-destroyed view.
useTabsStore.subscribe((s) => {
  const st = useInstrumentStore.getState();
  const live = (id: string | null): boolean => !!id && s.tabs.some((t) => t.id === id);
  // Second pane's tab closed elsewhere → collapse the split to the primary.
  if (st.secondaryTabId && !live(st.secondaryTabId)) {
    useInstrumentStore.setState({ secondaryTabId: null, secondaryKind: null });
  }
  // Primary's tab closed elsewhere → promote a surviving second pane; else feature
  // the next remaining tool tab (the strip keeps them alive), preferring the tab
  // main just made active; else drop to the pure canvas (no blank chrome).
  if (st.tabId && !live(st.tabId)) {
    const cur = useInstrumentStore.getState();
    if (live(cur.secondaryTabId)) {
      useInstrumentStore.setState({
        tabId: cur.secondaryTabId,
        kind: cur.secondaryKind,
        secondaryTabId: null,
        secondaryKind: null,
      });
    } else {
      const next =
        (s.activeTabId && s.activeTabId !== st.tabId
          ? s.tabs.find((t) => t.id === s.activeTabId)
          : undefined) ?? s.tabs.find((t) => t.id !== st.tabId);
      if (next) {
        void useTabsStore.getState().activateTab(next.id);
        useInstrumentStore.setState({ tabId: next.id, kind: next.kind, secondaryTabId: null, secondaryKind: null });
      } else {
        useInstrumentStore.setState({ tabId: null, kind: null, secondaryTabId: null, secondaryKind: null, maximized: false });
      }
    }
  }
});

/**
 * Open a tool surface as Mission Control's full-area instrument: create the tab,
 * activate it (so a native web/terminal view paints), and host it in the dock.
 * This is the entry point for surfaces that have no task Resource — Settings, a
 * fresh AI Chat / CLI chat, a new editor, a blank web tab — summoned from the ⌘K
 * command palette (the redesign's Phase 4). Mirrors the Resource path in
 * WorkGraphInspector.openResource, which is the other caller of {@link useInstrumentStore}.
 */
export async function openInstrument(
  kind: TabKind,
  opts?: { url?: string; workspaceId?: WorkspaceId; terminalProfile?: 'agent-cli' },
): Promise<void> {
  const id = await useTabsStore
    .getState()
    .newTab(
      kind,
      opts?.url,
      opts?.workspaceId,
      opts?.terminalProfile ? { terminalProfile: opts.terminalProfile } : undefined,
    );
  if (!id) return;
  // Add it to the Workbench strip and feature it (no replace — the previously
  // open tools stay as their own tabs). feature() activates the tab so its view paints.
  useInstrumentStore.getState().feature(id, kind);
}

/**
 * Open a tool as a SECOND pane beside the current instrument (a side-by-side split)
 * — e.g. an editor on the left, the running app/Preview on the right. Mirrors
 * {@link openInstrument} but adopts the new tab via splitWith instead of open, so
 * the primary pane stays. No-op when no instrument is open (nothing to split).
 * Both web panes report their own rect, so the existing browser:set-pane-bounds
 * pipeline tiles both native views with no main-process change.
 */
export async function splitInstrument(
  kind: TabKind,
  opts?: { url?: string; workspaceId?: WorkspaceId; terminalProfile?: 'agent-cli'; dir?: SplitDir },
): Promise<void> {
  if (!useInstrumentStore.getState().tabId) return;
  const id = await useTabsStore
    .getState()
    .newTab(
      kind,
      opts?.url,
      opts?.workspaceId,
      opts?.terminalProfile ? { terminalProfile: opts.terminalProfile } : undefined,
    );
  if (!id) return;
  // Focus the new pane (omnibox/keyboard target). Both panes still paint: each web
  // pane reports a rect, so main's applyPaneBounds tiles every view that has one.
  await useTabsStore.getState().activateTab(id);
  useInstrumentStore.getState().splitWith(id, kind, opts?.dir ?? 'row');
}

/**
 * Reopen the most recently closed tab (Ctrl/Cmd+Shift+T, the ⌘K "Reopen Closed
 * Tab" command) and host it as Mission Control's full-area instrument. Main
 * reopens + activates the tab and hands back its { id, kind }; without hosting it
 * here a reopened web tab paints a native view over the graph with no chrome and a
 * reopened editor is invisible (InstrumentStage is MC's only tab surface, gated on
 * useInstrumentStore.tabId). No-op when the closed-tab stack is empty. Mirrors
 * {@link openInstrument} — including closing the just-reopened tab if the
 * dirty-editor prompt cancels the switch (open() returns false), so it doesn't
 * leak as a hidden orphan. Lives here (not in tabs/store) so the base tab registry
 * never imports the instrument store back (cycle-free).
 */
export async function reopenTabInstrument(): Promise<void> {
  const reopened = await useTabsStore.getState().reopenClosedTab();
  if (!reopened) return;
  useInstrumentStore.getState().feature(reopened.id, reopened.kind);
}

/**
 * Open a workspace file in an editor instrument. The summonable panels (Files /
 * Search) open files this way: editorStore.openFile creates + activates the
 * editor tab, then we host that tab as the full-area instrument (replacing the
 * panel). Optional line/col positions the cursor (Search match → file:line:col).
 */
export async function openFileInstrument(
  file: EditorFileInput,
  line?: number,
  col?: number,
): Promise<void> {
  // editorStore.openFile FOCUSES an already-open file (returning its existing
  // tab id) rather than always minting a fresh one. Snapshot the live tab ids
  // BEFORE opening so we can tell a brand-new tab from a pre-existing one and
  // only tear down a tab we actually created on a cancelled prompt.
  const id =
    line !== undefined && col !== undefined
      ? await useEditorStore.getState().openFileAt(file, line, col)
      : await useEditorStore.getState().openFile(file);
  // Feature the editor in the Workbench strip (additive — other tools stay open).
  if (id) useInstrumentStore.getState().feature(id, 'editor');
}
