import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceId, WorkspaceRootId } from '../../../shared/workspace';

// Capture toast() calls so we can assert the user-facing surface fires on reject,
// without standing up the real <ToastHost>. Hoisted by vitest before the import.
const toastSpy = vi.fn();
vi.mock('../../lib/toast', () => ({ toast: (input: unknown) => toastSpy(input) }));

import { useWorkspaceDeckStore } from './store';

type MarudeskMock = { invoke: ReturnType<typeof vi.fn> };

function setInvoke(invoke: MarudeskMock['invoke']): void {
  (globalThis as unknown as { window: { marudesk: MarudeskMock } }).window.marudesk = {
    invoke,
  };
}

const reset = useWorkspaceDeckStore.getState();

beforeEach(() => {
  toastSpy.mockReset();
  useWorkspaceDeckStore.setState({ error: null });
});

afterEach(() => {
  useWorkspaceDeckStore.setState({ error: reset.error });
});

describe('workspace deck store — failing title-bar actions surface, never throw', () => {
  it('setActiveWorkspace records the error and toasts on reject without throwing', async () => {
    setInvoke(vi.fn(async () => Promise.reject(new Error('root deleted'))));

    // The fire-and-forget callers (`void setActiveWorkspace(…)`) rely on this
    // never rejecting — so awaiting it must resolve normally.
    await expect(
      useWorkspaceDeckStore.getState().setActiveWorkspace('ws-1' as WorkspaceId),
    ).resolves.toBeUndefined();

    expect(useWorkspaceDeckStore.getState().error).toBe('root deleted');
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'root deleted', variant: 'error' }),
    );
  });

  it('setActiveRoot records the error and toasts on reject without throwing', async () => {
    setInvoke(vi.fn(async () => Promise.reject(new Error('ssh dropped'))));

    await expect(
      useWorkspaceDeckStore
        .getState()
        .setActiveRoot('ws-1' as WorkspaceId, 'root-1' as WorkspaceRootId),
    ).resolves.toBeUndefined();

    expect(useWorkspaceDeckStore.getState().error).toBe('ssh dropped');
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'ssh dropped', variant: 'error' }),
    );
  });

  // The MUTATIONS (create/rename/delete/add-root/remove-root) are also void-called
  // from the WorkspaceSwitcher, whose menu has closed by the time a reject lands —
  // previously they only set `error` (which nothing renders), so a failed action
  // looked like a no-op. Each must now toast and resolve (never throw).
  it('createWorkspace toasts and returns null on reject without throwing', async () => {
    setInvoke(vi.fn(async () => Promise.reject(new Error('disk full'))));
    await expect(
      useWorkspaceDeckStore.getState().createWorkspace('Beta', [{ name: 'beta', path: '/tmp/beta' }]),
    ).resolves.toBeNull();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'disk full', variant: 'error' }),
    );
  });

  it('renameWorkspace toasts on reject without throwing', async () => {
    setInvoke(vi.fn(async () => Promise.reject(new Error('name taken'))));
    await expect(
      useWorkspaceDeckStore.getState().renameWorkspace('ws-1' as WorkspaceId, 'New name'),
    ).resolves.toBeUndefined();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'name taken', variant: 'error' }),
    );
  });

  it('deleteWorkspace toasts on reject without throwing', async () => {
    setInvoke(vi.fn(async () => Promise.reject(new Error('workspace in use'))));
    await expect(
      useWorkspaceDeckStore.getState().deleteWorkspace('ws-1' as WorkspaceId),
    ).resolves.toBeUndefined();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'workspace in use', variant: 'error' }),
    );
  });

  it('addRoot toasts and returns null on reject without throwing', async () => {
    setInvoke(vi.fn(async () => Promise.reject(new Error('add-root failed'))));
    await expect(
      useWorkspaceDeckStore.getState().addRoot('ws-1' as WorkspaceId),
    ).resolves.toBeNull();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'add-root failed', variant: 'error' }),
    );
  });

  it('removeRoot toasts on reject without throwing', async () => {
    setInvoke(vi.fn(async () => Promise.reject(new Error('remove-root failed'))));
    await expect(
      useWorkspaceDeckStore
        .getState()
        .removeRoot('ws-1' as WorkspaceId, 'root-1' as WorkspaceRootId),
    ).resolves.toBeUndefined();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'remove-root failed', variant: 'error' }),
    );
  });
});
