import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The instrument owns exactly one tab and is the source of truth for tearing
 * down its native WebContentsView. open() must be SYMMETRIC with close(): when
 * switching away from a dirty previous tab and the user CANCELS the discard
 * prompt, the switch is aborted so the previous tab is neither closed nor
 * orphaned. Only an honored prompt (or no dirty tab) closes prev + sets new.
 */

const confirmCloseTab = vi.fn<(tab: unknown) => boolean>();
const closeTab = vi.fn<(id: string) => Promise<void>>(async () => {});
const activateTab = vi.fn<(id: string) => Promise<void>>(async () => {});
const newTab = vi.fn<() => Promise<string | null>>(async () => 'next');
const openFile = vi.fn<() => Promise<string | null>>(async () => 'next');
const reopenClosedTab = vi.fn<
  () => Promise<{ id: string; kind: string } | null>
>(async () => ({ id: 'next', kind: 'web' }));

vi.mock('../editor/store', () => ({
  confirmCloseTab: (tab: unknown) => confirmCloseTab(tab),
  useEditorStore: {
    getState: () => ({
      openFile: () => openFile(),
      openFileAt: () => openFile(),
    }),
  },
}));

// The live tab registry. `prev` is the dirty previous instrument; tests that
// exercise the "file already open" path push the pre-existing tab in here so the
// snapshot in openFileInstrument can distinguish it from a freshly-created tab.
let tabs: Array<{ id: string; kind: string }> = [{ id: 'prev', kind: 'editor' }];

vi.mock('../tabs/store', () => ({
  useTabsStore: {
    getState: () => ({
      tabs,
      closeTab: (id: string) => closeTab(id),
      activateTab: (id: string) => activateTab(id),
      newTab: () => newTab(),
      reopenClosedTab: () => reopenClosedTab(),
    }),
    // The module subscribes for the dangling-tab cleanup; a no-op unsubscribe is
    // enough for these store-level assertions.
    subscribe: () => () => {},
  },
}));

const { useInstrumentStore, openInstrument, openFileInstrument, reopenTabInstrument } =
  await import('./instrument');

describe('useInstrumentStore.open dirty-prompt symmetry', () => {
  beforeEach(() => {
    confirmCloseTab.mockReset();
    closeTab.mockReset();
    closeTab.mockResolvedValue(undefined);
    activateTab.mockReset();
    activateTab.mockResolvedValue(undefined);
    tabs = [{ id: 'prev', kind: 'editor' }];
    useInstrumentStore.setState({ tabId: 'prev', kind: 'editor' });
  });

  it('aborts the switch and keeps prev when the dirty prompt is CANCELLED', () => {
    confirmCloseTab.mockReturnValue(false);

    const adopted = useInstrumentStore.getState().open('next', 'web');

    // Returns false so the CREATE caller can tear down its just-created tab.
    expect(adopted).toBe(false);
    expect(useInstrumentStore.getState().tabId).toBe('prev');
    expect(useInstrumentStore.getState().kind).toBe('editor');
    expect(closeTab).not.toHaveBeenCalled();
    // The abandoned just-activated tab is re-synced back to prev so main doesn't
    // paint it over the kept instrument.
    expect(activateTab).toHaveBeenCalledWith('prev');
  });

  it('closes prev and sets new when the prompt is HONORED', () => {
    confirmCloseTab.mockReturnValue(true);

    const adopted = useInstrumentStore.getState().open('next', 'web');

    expect(adopted).toBe(true);
    expect(closeTab).toHaveBeenCalledWith('prev');
    expect(useInstrumentStore.getState().tabId).toBe('next');
    expect(useInstrumentStore.getState().kind).toBe('web');
  });

  it('does not prompt or close when switching to the same tab', () => {
    const adopted = useInstrumentStore.getState().open('prev', 'editor');

    expect(adopted).toBe(true);
    expect(confirmCloseTab).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
    expect(useInstrumentStore.getState().tabId).toBe('prev');
  });

  it('sets the new tab without prompting when there is no previous instrument', () => {
    useInstrumentStore.setState({ tabId: null, kind: null });

    const adopted = useInstrumentStore.getState().open('next', 'web');

    expect(adopted).toBe(true);
    expect(confirmCloseTab).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
    expect(useInstrumentStore.getState().tabId).toBe('next');
    expect(useInstrumentStore.getState().kind).toBe('web');
  });
});

describe('CREATE callers close the just-created tab on a cancelled prompt', () => {
  beforeEach(() => {
    confirmCloseTab.mockReset();
    closeTab.mockReset();
    closeTab.mockResolvedValue(undefined);
    activateTab.mockReset();
    activateTab.mockResolvedValue(undefined);
    newTab.mockReset();
    newTab.mockResolvedValue('next');
    openFile.mockReset();
    openFile.mockResolvedValue('next');
    tabs = [{ id: 'prev', kind: 'editor' }];
    // A dirty previous instrument is what triggers the discard prompt on switch.
    useInstrumentStore.setState({ tabId: 'prev', kind: 'editor' });
  });

  it('openInstrument closes the new tab when the dirty prompt is CANCELLED', async () => {
    confirmCloseTab.mockReturnValue(false);

    await openInstrument('web');

    // Switch aborted: prev kept, and the freshly-created tab is torn down so no
    // hidden WebContentsView orphan survives.
    expect(useInstrumentStore.getState().tabId).toBe('prev');
    expect(closeTab).toHaveBeenCalledWith('next');
  });

  it('openInstrument does NOT close the new tab when the prompt is HONORED', async () => {
    confirmCloseTab.mockReturnValue(true);

    await openInstrument('web');

    // Adopted: only the previous tab is closed, never the just-adopted one.
    expect(useInstrumentStore.getState().tabId).toBe('next');
    expect(closeTab).toHaveBeenCalledWith('prev');
    expect(closeTab).not.toHaveBeenCalledWith('next');
  });

  it('openFileInstrument closes the new editor tab when the prompt is CANCELLED', async () => {
    confirmCloseTab.mockReturnValue(false);

    await openFileInstrument('/tmp/a.ts');

    expect(useInstrumentStore.getState().tabId).toBe('prev');
    expect(closeTab).toHaveBeenCalledWith('next');
  });

  it('openFileInstrument does NOT close the new editor tab when the prompt is HONORED', async () => {
    confirmCloseTab.mockReturnValue(true);

    await openFileInstrument('/tmp/a.ts');

    expect(useInstrumentStore.getState().tabId).toBe('next');
    expect(closeTab).toHaveBeenCalledWith('prev');
    expect(closeTab).not.toHaveBeenCalledWith('next');
  });

  it('openFileInstrument does NOT close a PRE-EXISTING editor tab when the prompt is CANCELLED', async () => {
    // The file is ALREADY open: editorStore.openFile focuses + returns its
    // EXISTING tab id ('prev'), not a fresh one. The current instrument is a
    // DIFFERENT dirty editor ('other'), so open('prev', …) hits the dirty prompt
    // and — cancelled — returns false. The close-on-cancel guard must leave the
    // pre-existing 'prev' alone (only a tab CREATED in this action is torn down).
    // (Current instrument MUST differ from the opened id, or open() returns true
    // via the same-tab fast path and never reaches the guard.)
    tabs = [
      { id: 'prev', kind: 'editor' },
      { id: 'other', kind: 'editor' },
    ];
    useInstrumentStore.setState({ tabId: 'other', kind: 'editor' });
    confirmCloseTab.mockReturnValue(false);
    openFile.mockResolvedValue('prev'); // already-open file → existing id

    await openFileInstrument('/tmp/already-open.ts');

    // Switch cancelled (stay on 'other'); the pre-existing 'prev' is preserved.
    expect(useInstrumentStore.getState().tabId).toBe('other');
    expect(closeTab).not.toHaveBeenCalledWith('prev');
  });
});

/**
 * Reopening a closed tab (Ctrl/Cmd+Shift+T, the ⌘K "Reopen Closed Tab" command)
 * must host the reopened tab as the full-area instrument — otherwise a reopened
 * web tab paints a native view over the graph with no chrome and a reopened editor
 * is invisible (InstrumentStage is MC's only tab surface). It is also a CREATE
 * caller, so it inherits the same orphan-teardown contract: a cancelled discard
 * prompt on the previous instrument tears the just-reopened tab down.
 */
describe('reopenTabInstrument hosts the reopened tab', () => {
  beforeEach(() => {
    confirmCloseTab.mockReset();
    closeTab.mockReset();
    closeTab.mockResolvedValue(undefined);
    activateTab.mockReset();
    activateTab.mockResolvedValue(undefined);
    reopenClosedTab.mockReset();
    reopenClosedTab.mockResolvedValue({ id: 'next', kind: 'web' });
    tabs = [{ id: 'prev', kind: 'editor' }];
  });

  it('hosts the reopened tab as the instrument (from the graph, no previous)', async () => {
    useInstrumentStore.setState({ tabId: null, kind: null });

    await reopenTabInstrument();

    expect(useInstrumentStore.getState().tabId).toBe('next');
    expect(useInstrumentStore.getState().kind).toBe('web');
    // Nothing to discard when reopening from the bare graph.
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('is a no-op when the closed-tab stack is empty (null)', async () => {
    useInstrumentStore.setState({ tabId: null, kind: null });
    reopenClosedTab.mockResolvedValue(null);

    await reopenTabInstrument();

    expect(useInstrumentStore.getState().tabId).toBeNull();
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('tears the just-reopened tab down when the dirty prompt is CANCELLED', async () => {
    // A dirty previous instrument triggers the discard prompt on the switch.
    useInstrumentStore.setState({ tabId: 'prev', kind: 'editor' });
    confirmCloseTab.mockReturnValue(false);

    await reopenTabInstrument();

    // Switch aborted: prev kept, and the freshly-reopened tab is torn down so no
    // hidden WebContentsView orphan survives.
    expect(useInstrumentStore.getState().tabId).toBe('prev');
    expect(closeTab).toHaveBeenCalledWith('next');
  });
});

describe('useInstrumentStore split (two-pane)', () => {
  beforeEach(() => {
    confirmCloseTab.mockReset();
    confirmCloseTab.mockReturnValue(true);
    closeTab.mockReset();
    closeTab.mockResolvedValue(undefined);
    tabs = [
      { id: 'prev', kind: 'editor' },
      { id: 'second', kind: 'terminal' },
    ];
    useInstrumentStore.setState({
      tabId: 'prev',
      kind: 'editor',
      secondaryTabId: null,
      secondaryKind: null,
      splitDir: 'row',
      splitRatio: 0.5,
    });
  });

  it('splitWith adds a second pane beside the primary', () => {
    useInstrumentStore.getState().splitWith('second', 'terminal', 'row');
    const s = useInstrumentStore.getState();
    expect(s.tabId).toBe('prev'); // primary stays
    expect(s.secondaryTabId).toBe('second');
    expect(s.secondaryKind).toBe('terminal');
  });

  it('splitWith is a no-op with no primary, or when tiling the primary with itself', () => {
    useInstrumentStore.setState({ tabId: null, kind: null });
    useInstrumentStore.getState().splitWith('second', 'terminal');
    expect(useInstrumentStore.getState().secondaryTabId).toBeNull();

    useInstrumentStore.setState({ tabId: 'prev', kind: 'editor' });
    useInstrumentStore.getState().splitWith('prev', 'editor');
    expect(useInstrumentStore.getState().secondaryTabId).toBeNull();
  });

  it('closeSplit tears down the second pane and collapses to the primary', () => {
    useInstrumentStore.setState({ secondaryTabId: 'second', secondaryKind: 'terminal' });
    useInstrumentStore.getState().closeSplit();
    expect(closeTab).toHaveBeenCalledWith('second');
    const s = useInstrumentStore.getState();
    expect(s.secondaryTabId).toBeNull();
    expect(s.tabId).toBe('prev'); // the primary survives
  });

  it('open() collapses a split — tears down the second pane and adopts the new single tool', () => {
    useInstrumentStore.setState({ secondaryTabId: 'second', secondaryKind: 'terminal' });
    const adopted = useInstrumentStore.getState().open('fresh', 'web');
    expect(adopted).toBe(true);
    expect(closeTab).toHaveBeenCalledWith('second');
    const s = useInstrumentStore.getState();
    expect(s.tabId).toBe('fresh');
    expect(s.secondaryTabId).toBeNull();
  });
});
