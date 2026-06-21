import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, WorkGraph } from '../../../shared/work-os';
import { useWorkGraphStore } from './store';
import {
  __resetTaskThreadsForTests,
  acquireTaskThread,
  dockRenderedThreadId,
  setDockRenderedThread,
  taskContextPreamble,
  taskThreadEntries,
  taskThreadId,
} from './taskThreads';

/**
 * The per-Task agent thread registry: a node owns one conversation thread, reused
 * across re-selection and torn down only when the task leaves the graph. Mirrors
 * the per-tab AI Chat registry's guarantees (cardThreads), the thing that makes
 * "you talk to the task, not a global bot" hold.
 */

type MarudeskMock = { invoke: ReturnType<typeof vi.fn> };

let threadSeq = 0;

function mockMarudesk(): MarudeskMock {
  threadSeq = 0;
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'agent:new-thread') {
      const id = `thread-${++threadSeq}`;
      return [{ id, active: true }];
    }
    if (channel === 'agent:close-thread') return [];
    return undefined;
  });
  (globalThis as unknown as { window: { marudesk: MarudeskMock } }).window.marudesk = { invoke };
  return { invoke };
}

function task(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    intent: '',
    kind: 'work',
    status: 'planned',
    executor: { type: 'agent', ref: 'agent' },
    inputs: [],
    outputs: [],
    acceptance: [],
  };
}

function graph(ids: string[]): WorkGraph {
  return {
    id: 'wg_test',
    goal: 'test',
    tasks: ids.map(task),
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

let marudesk: MarudeskMock;

beforeEach(() => {
  marudesk = mockMarudesk();
  __resetTaskThreadsForTests();
  useWorkGraphStore.getState().clearGraph();
});

afterEach(() => {
  __resetTaskThreadsForTests();
  useWorkGraphStore.getState().clearGraph();
});

describe('taskThreads registry', () => {
  it('creates one thread per task and reuses it across re-acquire', async () => {
    const first = await acquireTaskThread('a');
    const again = await acquireTaskThread('a');
    expect(first).toBe('thread-1');
    expect(again).toBe('thread-1');
    expect(taskThreadId('a')).toBe('thread-1');
    // Only one new-thread call despite two acquires — the conversation is reused.
    expect(marudesk.invoke).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent acquires of the same task into one thread', async () => {
    const [a, b] = await Promise.all([acquireTaskThread('a'), acquireTaskThread('a')]);
    expect(a).toBe('thread-1');
    expect(b).toBe('thread-1');
    expect(marudesk.invoke).toHaveBeenCalledTimes(1);
  });

  it('gives different tasks distinct threads', async () => {
    const a = await acquireTaskThread('a');
    const b = await acquireTaskThread('b');
    expect(a).toBe('thread-1');
    expect(b).toBe('thread-2');
    expect(taskThreadEntries()).toEqual(
      expect.arrayContaining([
        { taskId: 'a', threadId: 'thread-1', workspaceId: undefined },
        { taskId: 'b', threadId: 'thread-2', workspaceId: undefined },
      ]),
    );
  });

  it('closes a task thread when the task is removed from the graph', async () => {
    useWorkGraphStore.getState().setGraph(graph(['a', 'b']));
    await acquireTaskThread('a');
    await acquireTaskThread('b');

    useWorkGraphStore.getState().deleteTask('a');

    expect(marudesk.invoke).toHaveBeenCalledWith('agent:close-thread', {
      id: 'thread-1',
      workspaceId: undefined,
    });
    expect(taskThreadId('a')).toBeNull();
    expect(taskThreadId('b')).toBe('thread-2');
  });

  it('publishes and clears the dock-rendered thread for toast suppression', () => {
    // Null until the dock renders a chat — a background completion still toasts.
    expect(dockRenderedThreadId()).toBeNull();
    // The dock publishes whatever thread it visibly shows (a resolved task thread
    // OR the workspace conversation it falls back to when acquire fails).
    setDockRenderedThread('thread-fallback');
    expect(dockRenderedThreadId()).toBe('thread-fallback');
    // Cleared on unmount/deselect so the suppression doesn't outlive the view.
    setDockRenderedThread(null);
    expect(dockRenderedThreadId()).toBeNull();
  });

  it('resets the dock-rendered thread on registry reset', () => {
    setDockRenderedThread('thread-x');
    __resetTaskThreadsForTests();
    expect(dockRenderedThreadId()).toBeNull();
  });

  it('does not close threads on a graph clear (transient empty)', async () => {
    useWorkGraphStore.getState().setGraph(graph(['a']));
    await acquireTaskThread('a');
    marudesk.invoke.mockClear();

    useWorkGraphStore.getState().clearGraph();

    expect(marudesk.invoke).not.toHaveBeenCalledWith(
      'agent:close-thread',
      expect.anything(),
    );
    expect(taskThreadId('a')).toBe('thread-1');
  });

  it('seeds a NEW task thread with the task-context preamble, once', async () => {
    const grounded: Task = {
      ...task('a'),
      title: 'Wire the dock chat',
      intent: 'The agent should know the task',
      acceptance: [
        { id: 'c1', text: 'preamble carries the title', verdict: 'unknown' },
        { id: 'c2', text: 'preamble carries the intent', verdict: 'unknown' },
      ],
    };
    useWorkGraphStore.getState().setGraph({
      id: 'wg_test',
      goal: 'test',
      tasks: [grounded],
      edges: [],
      createdAt: 1,
      updatedAt: 1,
    });

    await acquireTaskThread('a');
    // First acquire mints a thread WITH the seedContext derived from the live task.
    const firstCall = marudesk.invoke.mock.calls.find(([ch]) => ch === 'agent:new-thread');
    expect(firstCall).toBeDefined();
    const payload = firstCall?.[1] as { workspaceId?: string; seedContext?: string } | undefined;
    expect(payload?.seedContext).toContain('Wire the dock chat');
    expect(payload?.seedContext).toContain('The agent should know the task');
    expect(payload?.seedContext).toContain('preamble carries the title');

    // Re-acquire returns the SAME thread and never mints (so never re-seeds).
    marudesk.invoke.mockClear();
    const again = await acquireTaskThread('a');
    expect(again).toBe('thread-1');
    expect(marudesk.invoke).not.toHaveBeenCalledWith('agent:new-thread', expect.anything());
  });

  it('mints a blank thread (no seedContext) when the task is not in the graph', async () => {
    // No graph set ⇒ liveTask is null ⇒ the contract's optional field is omitted.
    await acquireTaskThread('ghost');
    const call = marudesk.invoke.mock.calls.find(([ch]) => ch === 'agent:new-thread');
    const payload = call?.[1] as { seedContext?: string } | undefined;
    expect(payload?.seedContext).toBeUndefined();
  });
});

describe('taskContextPreamble', () => {
  it('grounds the preamble in title, intent, acceptance, and latest result', () => {
    const t: Task = {
      ...task('a'),
      title: 'Refactor the parser',
      intent: 'Split the monolith parser into small helpers',
      acceptance: [
        { id: 'c1', text: 'all existing tests pass', verdict: 'unknown' },
        { id: 'c2', text: 'no public API changes', verdict: 'unknown' },
      ],
      evidence: {
        trajectory: [],
        result: 'Extracted tokenizer + 3 helpers; suite green.',
      },
    };
    const preamble = taskContextPreamble(t);
    expect(preamble).toContain('Refactor the parser');
    expect(preamble).toContain('Split the monolith parser into small helpers');
    expect(preamble).toContain('- all existing tests pass');
    expect(preamble).toContain('- no public API changes');
    expect(preamble).toContain('Extracted tokenizer + 3 helpers; suite green.');
  });

  it('handles a planned task with no acceptance, no intent, and no evidence', () => {
    const t: Task = { ...task('a'), title: 'Bare task', intent: '', acceptance: [] };
    const preamble = taskContextPreamble(t);
    expect(preamble).toContain('Bare task');
    // No acceptance section and no result/intent lines when those fields are empty.
    expect(preamble).not.toContain('Acceptance criteria:');
    expect(preamble).not.toContain('Latest result:');
    expect(preamble).not.toContain('Intent:');
  });

  it('clips an overlong latest result so the preamble stays compact', () => {
    const t: Task = {
      ...task('a'),
      evidence: { trajectory: [], result: 'x'.repeat(2000) },
    };
    const preamble = taskContextPreamble(t);
    expect(preamble).toContain('…');
    // Far shorter than the raw 2000-char result.
    expect(preamble.length).toBeLessThan(900);
  });
});
