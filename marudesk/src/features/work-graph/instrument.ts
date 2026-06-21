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
  open: (tabId: string, kind: TabKind) => void;
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
        void useTabsStore.getState().activateTab(prev);
        return;
      }
      void useTabsStore.getState().closeTab(prev);
    }
    set({ tabId, kind });
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
  useInstrumentStore.getState().open(id, kind);
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
  const id =
    line !== undefined && col !== undefined
      ? await useEditorStore.getState().openFileAt(file, line, col)
      : await useEditorStore.getState().openFile(file);
  if (id) useInstrumentStore.getState().open(id, 'editor');
}
