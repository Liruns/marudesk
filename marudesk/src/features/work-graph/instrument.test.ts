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

vi.mock('../editor/store', () => ({
  confirmCloseTab: (tab: unknown) => confirmCloseTab(tab),
  // openInstrument/openFileInstrument aren't exercised here; the store module
  // only needs these symbols to exist for its imports.
  useEditorStore: { getState: () => ({}) },
}));

vi.mock('../tabs/store', () => ({
  useTabsStore: {
    getState: () => ({
      tabs: [
        { id: 'prev', kind: 'editor' },
        { id: 'next', kind: 'web' },
      ],
      closeTab: (id: string) => closeTab(id),
      activateTab: (id: string) => activateTab(id),
    }),
    // The module subscribes for the dangling-tab cleanup; a no-op unsubscribe is
    // enough for these store-level assertions.
    subscribe: () => () => {},
  },
}));

const { useInstrumentStore } = await import('./instrument');

describe('useInstrumentStore.open dirty-prompt symmetry', () => {
  beforeEach(() => {
    confirmCloseTab.mockReset();
    closeTab.mockReset();
    closeTab.mockResolvedValue(undefined);
    activateTab.mockReset();
    activateTab.mockResolvedValue(undefined);
    useInstrumentStore.setState({ tabId: 'prev', kind: 'editor' });
  });

  it('aborts the switch and keeps prev when the dirty prompt is CANCELLED', () => {
    confirmCloseTab.mockReturnValue(false);

    useInstrumentStore.getState().open('next', 'web');

    expect(useInstrumentStore.getState().tabId).toBe('prev');
    expect(useInstrumentStore.getState().kind).toBe('editor');
    expect(closeTab).not.toHaveBeenCalled();
    // The abandoned just-activated tab is re-synced back to prev so main doesn't
    // paint it over the kept instrument.
    expect(activateTab).toHaveBeenCalledWith('prev');
  });

  it('closes prev and sets new when the prompt is HONORED', () => {
    confirmCloseTab.mockReturnValue(true);

    useInstrumentStore.getState().open('next', 'web');

    expect(closeTab).toHaveBeenCalledWith('prev');
    expect(useInstrumentStore.getState().tabId).toBe('next');
    expect(useInstrumentStore.getState().kind).toBe('web');
  });

  it('does not prompt or close when switching to the same tab', () => {
    useInstrumentStore.getState().open('prev', 'editor');

    expect(confirmCloseTab).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
    expect(useInstrumentStore.getState().tabId).toBe('prev');
  });

  it('sets the new tab without prompting when there is no previous instrument', () => {
    useInstrumentStore.setState({ tabId: null, kind: null });

    useInstrumentStore.getState().open('next', 'web');

    expect(confirmCloseTab).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
    expect(useInstrumentStore.getState().tabId).toBe('next');
    expect(useInstrumentStore.getState().kind).toBe('web');
  });
});
