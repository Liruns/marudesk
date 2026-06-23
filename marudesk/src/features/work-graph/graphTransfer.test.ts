import { describe, expect, it } from 'vitest';
import type { WorkGraph } from '../../../shared/work-os';
import { GRAPH_TRANSFER_VERSION, parseGraphTransfer, serializeGraphTransfer } from './graphTransfer';

const GRAPH: WorkGraph = {
  id: 'wg1',
  goal: 'demo',
  tasks: [
    { id: 'a', title: 'A', intent: '', kind: 'work', status: 'planned', executor: { type: 'agent', ref: 'x' }, inputs: [], outputs: [], acceptance: [] },
    { id: 'b', title: 'B', intent: '', kind: 'decision', status: 'planned', executor: { type: 'human' }, inputs: [], outputs: [], acceptance: [] },
  ],
  edges: [{ id: 'a->b', from: 'a', to: 'b', type: 'depends_on' }],
  createdAt: 1,
  updatedAt: 2,
};

describe('graph transfer (export / import)', () => {
  it('round-trips a graph and its node layout', () => {
    const json = serializeGraphTransfer(GRAPH, { a: { x: 10, y: 20 }, b: { x: 30, y: 40 } });
    expect(JSON.parse(json).version).toBe(GRAPH_TRANSFER_VERSION);

    const parsed = parseGraphTransfer(json);
    expect(parsed).not.toBeNull();
    expect(parsed?.graph.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(parsed?.graph.tasks[1]?.kind).toBe('decision');
    expect(parsed?.graph.edges).toHaveLength(1);
    expect(parsed?.pos).toEqual({ a: { x: 10, y: 20 }, b: { x: 30, y: 40 } });
  });

  it('accepts a bare graph object (no transfer wrapper)', () => {
    const bare = JSON.stringify({ tasks: [{ id: 'a', title: 'A' }], edges: [] });
    const parsed = parseGraphTransfer(bare);
    expect(parsed?.graph.tasks).toHaveLength(1);
    expect(parsed?.pos).toEqual({});
  });

  it('rejects non-JSON, empty, and cyclic graphs (validated by parseWorkGraph)', () => {
    expect(parseGraphTransfer('not json at all')).toBeNull();
    expect(parseGraphTransfer('42')).toBeNull();
    expect(parseGraphTransfer(JSON.stringify({ graph: { tasks: [] } }))).toBeNull();
    const cyclic = JSON.stringify({
      graph: {
        tasks: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      },
    });
    expect(parseGraphTransfer(cyclic)).toBeNull();
  });

  it('sanitizes positions — drops unknown ids and non-finite coordinates', () => {
    const dirty = JSON.stringify({
      graph: { tasks: [{ id: 'a', title: 'A' }], edges: [] },
      pos: { a: { x: 1, y: 2 }, ghost: { x: 9, y: 9 }, bad: { x: 'nope', y: 2 }, nan: { x: 0, y: Number.NaN } },
    });
    const parsed = parseGraphTransfer(dirty);
    // Only the in-graph task with finite numeric coords survives.
    expect(parsed?.pos).toEqual({ a: { x: 1, y: 2 } });
  });
});
