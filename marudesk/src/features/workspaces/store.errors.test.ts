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
});
