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

describe('CREATE callers FEATURE the new tab additively (tab strip, no replace)', () => {
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
    // A previously-featured tool — it must STAY OPEN (as a strip tab) when a new
    // tool is summoned; the Workbench keeps tools alive rather than replacing them.
    useInstrumentStore.setState({ tabId: 'prev', kind: 'editor' });
  });

  it('openInstrument features the new tab and keeps the previous tool open', async () => {
    await openInstrument('web');

    // Additive: the new tool is featured, the previous one is NOT torn down (it
    // remains in the strip), and there is no discard prompt — switching can never
    // lose a dirty editor because nothing is closed.
    expect(useInstrumentStore.getState().tabId).toBe('next');
    expect(useInstrumentStore.getState().kind).toBe('web');
    expect(activateTab).toHaveBeenCalledWith('next');
    expect(closeTab).not.toHaveBeenCalled();
    expect(confirmCloseTab).not.toHaveBeenCalled();
  });

  it('openFileInstrument features the editor and keeps the previous tool open', async () => {
    await openFileInstrument('/tmp/a.ts');

    expect(useInstrumentStore.getState().tabId).toBe('next');
    expect(useInstrumentStore.getState().kind).toBe('editor');
    expect(closeTab).not.toHaveBeenCalled();
    expect(confirmCloseTab).not.toHaveBeenCalled();
  });

  it('openFileInstrument re-features an ALREADY-OPEN file without disturbing the others', async () => {
    // The file is already open: editorStore.openFile focuses + returns its
    // EXISTING tab id ('prev'). Featuring it is a plain switch — no tab is closed.
    tabs = [
      { id: 'prev', kind: 'editor' },
      { id: 'other', kind: 'editor' },
    ];
    useInstrumentStore.setState({ tabId: 'other', kind: 'editor' });
    openFile.mockResolvedValue('prev'); // already-open file → existing id

    await openFileInstrument('/tmp/already-open.ts');

    expect(useInstrumentStore.getState().tabId).toBe('prev');
    expect(closeTab).not.toHaveBeenCalled();
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

  it('features the reopened tab additively, keeping the previous tool open', async () => {
    // A previously-featured tool stays open as a strip tab when a tab is reopened —
    // reopen FEATURES the recovered tab without closing anything (no discard prompt).
    useInstrumentStore.setState({ tabId: 'prev', kind: 'editor' });

    await reopenTabInstrument();

    expect(useInstrumentStore.getState().tabId).toBe('next');
    expect(useInstrumentStore.getState().kind).toBe('web');
    expect(closeTab).not.toHaveBeenCalled();
    expect(confirmCloseTab).not.toHaveBeenCalled();
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
