import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZERO_NAV, type TabState } from '../../../shared/browser';
import { confirmCloseTab, useEditorStore } from './store';
import { useToastStore } from '../../lib/toast';

function editorTab(id: string, extra?: Partial<TabState>): TabState {
  return { ...ZERO_NAV, id, kind: 'editor', workspaceId: 'system', ...extra };
}

function reset(): void {
  useEditorStore.setState({ files: {}, fileRefs: {} });
  useToastStore.setState({ toasts: [] });
}

describe('editor save failure surfacing', () => {
  beforeEach(() => {
    reset();
    (globalThis as unknown as { window: { marudesk: unknown } }).window.marudesk = {
      invoke: async (channel: string) => {
        if (channel === 'workspace:write-file') throw new Error('disk full');
        return undefined;
      },
      on: () => () => {},
    };
  });

  it('keeps the buffer dirty, clears saving, records the error, and toasts when a write rejects', async () => {
    const path = 'src/app.ts';
    useEditorStore.setState({
      files: { [path]: { status: 'ready', kind: 'text', content: 'new', saved: 'old' } },
    });

    await useEditorStore.getState().save(path);

    const buf = useEditorStore.getState().files[path];
    if (!buf || buf.status !== 'ready' || buf.kind !== 'text') {
      throw new Error('expected a ready text buffer');
    }
    // No silent data loss: content preserved, still dirty (saved unchanged).
    expect(buf.content).toBe('new');
    expect(buf.saved).toBe('old');
    expect(buf.saving).toBe(false);
    expect(buf.error).toBe('disk full');

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.variant).toBe('error');
  });

  it('a user-canceled Save As (ok:false, no reason) stays fully silent — no toast, no error', async () => {
    const key = 'untitled-t9';
    useEditorStore.setState({
      files: { [key]: { status: 'ready', kind: 'text', content: 'draft' } },
    });
    (globalThis as unknown as { window: { marudesk: unknown } }).window.marudesk = {
      invoke: async (channel: string) => (channel === 'workspace:save-as' ? { ok: false } : undefined),
      on: () => () => {},
    };

    await useEditorStore.getState().saveUntitled(key);

    const buf = useEditorStore.getState().files[key];
    if (!buf || buf.status !== 'ready' || buf.kind !== 'text') throw new Error('expected a ready text buffer');
    expect(buf.error).toBeUndefined();
    expect(buf.saving).toBe(false);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('a real Save As error (ok:false WITH reason) surfaces one error toast', async () => {
    const key = 'untitled-t10';
    useEditorStore.setState({
      files: { [key]: { status: 'ready', kind: 'text', content: 'draft' } },
    });
    (globalThis as unknown as { window: { marudesk: unknown } }).window.marudesk = {
      invoke: async (channel: string) =>
        channel === 'workspace:save-as' ? { ok: false, reason: 'File must be saved inside the workspace.' } : undefined,
      on: () => () => {},
    };

    await useEditorStore.getState().saveUntitled(key);

    const buf = useEditorStore.getState().files[key];
    if (!buf || buf.status !== 'ready' || buf.kind !== 'text') throw new Error('expected a ready text buffer');
    expect(buf.error).toBe('File must be saved inside the workspace.');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.variant).toBe('error');
  });

  it('editing the buffer clears a prior save error (and its pill)', async () => {
    const path = 'src/app.ts';
    useEditorStore.setState({
      files: { [path]: { status: 'ready', kind: 'text', content: 'new', saved: 'old', error: 'disk full' } },
    });
    useEditorStore.getState().setContent(path, 'newer');
    const buf = useEditorStore.getState().files[path];
    if (!buf || buf.status !== 'ready' || buf.kind !== 'text') throw new Error('expected a ready text buffer');
    expect(buf.error).toBeUndefined();
  });

  it('clears a prior save error on the next successful save', async () => {
    const path = 'src/app.ts';
    useEditorStore.setState({
      files: { [path]: { status: 'ready', kind: 'text', content: 'new', saved: 'old', error: 'disk full' } },
    });
    // Swap the stub to a writer that succeeds.
    (globalThis as unknown as { window: { marudesk: unknown } }).window.marudesk = {
      invoke: async () => undefined,
      on: () => () => {},
    };

    await useEditorStore.getState().save(path);

    const buf = useEditorStore.getState().files[path];
    if (!buf || buf.status !== 'ready' || buf.kind !== 'text') {
      throw new Error('expected a ready text buffer');
    }
    expect(buf.saved).toBe('new'); // persisted
    expect(buf.error).toBeUndefined(); // stale error cleared
  });
});

describe('confirmCloseTab — untitled scratch buffers are not dropped silently', () => {
  beforeEach(reset);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops an EMPTY untitled buffer without prompting', () => {
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    // No buffer stored for untitled-t1 → treated as empty.
    expect(confirmCloseTab(editorTab('t1'))).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('prompts before discarding a NON-EMPTY untitled buffer and returns the choice', () => {
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    useEditorStore.setState({
      files: { 'untitled-t1': { status: 'ready', kind: 'text', content: 'draft', saved: undefined } },
    });
    // Declined → keep the tab open (false), and the prompt was shown.
    expect(confirmCloseTab(editorTab('t1'))).toBe(false);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });
});
