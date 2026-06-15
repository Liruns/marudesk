import { describe, expect, it } from 'vitest';
import { freeTaskSlot, setTaskOutcome, upstreamContextOf } from './store';
import type { Task, WorkGraph } from '../../../shared/work-os';

const NODE = { w: 208, h: 118 };

function mkTask(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id.toUpperCase(),
    intent: '',
    kind: 'work',
    status: 'planned',
    author: 'agent',
    executor: { type: 'agent', ref: 'agent' },
    inputs: [],
    outputs: [],
    acceptance: [],
    ...extra,
  };
}

function mkGraph(tasks: Task[], deps: [string, string][]): WorkGraph {
  return {
    id: 'g',
    goal: 'goal',
    tasks,
    edges: deps.map(([from, to]) => ({ id: `${from}~${to}`, from, to, type: 'depends_on' as const })),
    createdAt: 0,
    updatedAt: 0,
  };
}

function overlaps(a: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + NODE.w > b.x && a.y < b.y + b.h && a.y + NODE.h > b.y;
}

describe('freeTaskSlot', () => {
  it('returns the anchor unchanged when nothing is occupied', () => {
    expect(freeTaskSlot({ x: 500, y: 80 }, [])).toEqual({ x: 500, y: 80 });
  });

  it('keeps the x and nudges down past an occupying tab card', () => {
    const occupied = [{ x: 480, y: 60, w: 640, h: 460 }];
    const slot = freeTaskSlot({ x: 500, y: 80 }, occupied);
    expect(slot.x).toBe(500);
    expect(occupied.some((o) => overlaps(slot, o))).toBe(false);
    expect(slot.y).toBeGreaterThan(80);
  });

  it('stacks below earlier task nodes at the same anchor', () => {
    const occupied = [
      { x: 500, y: 80, w: NODE.w, h: NODE.h },
      { x: 500, y: 80 + NODE.h + 56, w: NODE.w, h: NODE.h },
    ];
    const slot = freeTaskSlot({ x: 500, y: 80 }, occupied);
    expect(slot.x).toBe(500);
    expect(occupied.every((o) => !overlaps(slot, o))).toBe(true);
  });
});

describe('upstreamContextOf', () => {
  it('threads each upstream task’s handoff (else result, else intent) into context', () => {
    const g = mkGraph(
      [
        mkTask('a', { title: 'Plan', handoff: 'use the orders schema' }),
        mkTask('b', { title: 'Build', intent: 'implement it', evidence: { trajectory: [], result: 'built the endpoint' } }),
        mkTask('c'),
      ],
      [['a', 'c'], ['b', 'c']],
    );
    const ctx = upstreamContextOf(g, 'c');
    expect(ctx).toContain('Plan: use the orders schema'); // handoff preferred
    expect(ctx).toContain('Build: built the endpoint'); // falls back to result
  });

  it('is empty for a task with no upstreams', () => {
    const g = mkGraph([mkTask('a')], []);
    expect(upstreamContextOf(g, 'a')).toBe('');
  });
});

describe('setTaskOutcome', () => {
  it('applies status, handoff, result evidence, and verdicts by criterion order', () => {
    const g = mkGraph(
      [mkTask('a', { acceptance: [{ id: 'c1', text: 'x', verdict: 'unknown' }, { id: 'c2', text: 'y', verdict: 'unknown' }] })],
      [],
    );
    const next = setTaskOutcome(g, 'a', { status: 'done', result: 'shipped', handoff: 'API is live', verdicts: ['pass', 'fail'] });
    const t = next.tasks[0];
    expect(t.status).toBe('done');
    expect(t.handoff).toBe('API is live');
    expect(t.evidence?.result).toBe('shipped');
    expect(t.acceptance.map((c) => c.verdict)).toEqual(['pass', 'fail']);
  });
});
