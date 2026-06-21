import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, WorkGraph } from '../../../shared/work-os';
import { useWorkGraphStore } from './store';
import {
  __resetTaskThreadsForTests,
  acquireTaskThread,
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
});
