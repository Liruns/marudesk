import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task, WorkGraph } from '../../../shared/work-os';
import type { ApplyPatchResult } from '../../../shared/work-os';
import { useWorkGraphStore } from './store';
import { useGitStore } from '../git/store';

/**
 * applyPatch writes real workspace files, so a successful apply must kick the
 * Source Control store to refresh — otherwise an already-open SCM instrument
 * keeps showing pre-apply status and the "agent diff → review → commit" handoff
 * breaks. The refresh is fire-and-forget and git's own refresh() self-guards a
 * non-repo / no-git workspace, so this only asserts the wiring: refresh is called
 * on success, and NOT on a failed apply.
 */

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    intent: '',
    kind: 'work',
    status: 'planned',
    executor: { type: 'agent', ref: 'agent' },
    inputs: [],
    outputs: [],
    acceptance: [],
    ...extra,
  };
}

function graphWithPatch(taskId: string, patch: string): WorkGraph {
  return {
    id: 'g',
    goal: 'goal',
    tasks: [task(taskId, { evidence: { trajectory: [], result: 'done', patch } })],
    edges: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

let applyResult: ApplyPatchResult;

beforeEach(() => {
  // The store modules expect a window.marudesk bridge; route apply-patch to the
  // per-test `applyResult` and stub the rest of the surface refresh() touches.
  (globalThis as unknown as { window: { marudesk: unknown } }).window.marudesk = {
    invoke: async (channel: string) => {
      if (channel === 'workos:apply-patch') return applyResult;
      if (channel === 'git:available') return { installed: false };
      return undefined;
    },
    on: () => () => {},
  };
});

describe('useWorkGraphStore.applyPatch', () => {
  it('refreshes Source Control after a successful apply', async () => {
    applyResult = { ok: true, changedFiles: ['src/a.ts'], verdict: 'pass' };
    const refresh = vi.fn(async () => {});
    useGitStore.setState({ refresh });
    useWorkGraphStore.setState({
      graph: graphWithPatch('t1', 'diff --git a b\n'),
      applyingPatchTaskId: null,
    });

    await useWorkGraphStore.getState().applyPatch('t1');

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not refresh Source Control when the apply fails', async () => {
    applyResult = { ok: false, reason: 'patch no longer applies cleanly' };
    const refresh = vi.fn(async () => {});
    useGitStore.setState({ refresh });
    useWorkGraphStore.setState({
      graph: graphWithPatch('t2', 'diff --git a b\n'),
      applyingPatchTaskId: null,
    });

    await useWorkGraphStore.getState().applyPatch('t2');

    expect(refresh).not.toHaveBeenCalled();
  });
});
