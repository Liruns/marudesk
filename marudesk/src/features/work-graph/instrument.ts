import { create } from 'zustand';
import type { TabKind } from '../../../shared/browser';
import type { WorkspaceId } from '../../../shared/workspace';
import { confirmCloseTab, useEditorStore, type EditorFileInput } from '../editor/store';
import { useTabsStore } from '../tabs/store';

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
   * Adopt `tabId` as the active instrument. Returns `true` when adopted (or when
   * switching to the same tab / from no instrument), and `false` when the switch
   * was cancelled at the dirty-editor prompt (prev is kept). Callers that created
   * `tabId` in main BEFORE calling open() MUST close it on a `false` return —
   * otherwise the just-created tab leaks as a hidden orphan whose live
   * WebContentsView can never be torn down.
   */
  open: (tabId: string, kind: TabKind) => boolean;
  close: () => void;
};

export const useInstrumentStore = create<InstrumentState>((set, get) => ({
  tabId: null,
  kind: null,
  open: (tabId, kind) => {
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
    set({ tabId, kind });
    return true;
  },
  close: () => {
    const prev = get().tabId;
    if (prev) {
      const tab = useTabsStore.getState().tabs.find((t) => t.id === prev);
      // Cancelling the dirty-editor prompt keeps you on the instrument.
      if (!confirmCloseTab(tab)) return;
      void useTabsStore.getState().closeTab(prev);
    }
    set({ tabId: null, kind: null });
  },
}));

// If an instrument's tab is closed from elsewhere (e.g. Ctrl/Cmd+W while it is the
// active tab), drop the dangling reference so the Shell returns to the graph
// instead of rendering blank instrument chrome over an already-destroyed view.
useTabsStore.subscribe((s) => {
  const id = useInstrumentStore.getState().tabId;
  if (id && !s.tabs.some((t) => t.id === id)) {
    useInstrumentStore.setState({ tabId: null, kind: null });
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
  await useTabsStore.getState().activateTab(id);
  // If the dirty-editor prompt is cancelled, open() keeps the previous instrument
  // and rejects `id` — close the tab we just created so it doesn't leak as a
  // hidden orphan (live WebContentsView that can never be torn down).
  if (!useInstrumentStore.getState().open(id, kind)) {
    await useTabsStore.getState().closeTab(id);
  }
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
  if (!useInstrumentStore.getState().open(reopened.id, reopened.kind)) {
    await useTabsStore.getState().closeTab(reopened.id);
  }
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
  const preExisting = new Set(useTabsStore.getState().tabs.map((t) => t.id));
  const id =
    line !== undefined && col !== undefined
      ? await useEditorStore.getState().openFileAt(file, line, col)
      : await useEditorStore.getState().openFile(file);
  if (id && !useInstrumentStore.getState().open(id, 'editor') && !preExisting.has(id)) {
    // Cancelled prompt kept the previous instrument: tear down the editor tab we
    // just created so it doesn't survive as an orphan. A pre-existing tab (the
    // file was already open) is left alone — open() already re-activated prev,
    // and closing it would drop a tab the user did not just create.
    await useTabsStore.getState().closeTab(id);
  }
}
