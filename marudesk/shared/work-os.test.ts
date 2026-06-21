import { describe, it, expect } from 'vitest';
import {
  blockedTaskIds,
  criterionVerifiableByChecker,
  dependenciesOf,
  dependentsOf,
  hasCycle,
  isEdgeType,
  isTaskStatus,
  parallelLayers,
  parseWorkGraph,
  readyTasks,
  topologicalOrder,
  type Criterion,
  type Task,
  type TaskStatus,
  type WorkGraph,
} from './work-os';

function task(id: string, status: TaskStatus = 'planned', extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    intent: '',
    kind: 'work',
    status,
    executor: { type: 'agent', ref: 'agent' },
    inputs: [],
    outputs: [],
    acceptance: [],
    ...extra,
  };
}

function graph(tasks: Task[], deps: [string, string][]): WorkGraph {
  return {
    id: 'g',
    goal: 'goal',
    tasks,
    edges: deps.map(([from, to]) => ({ id: `${from}~${to}`, from, to, type: 'depends_on' as const })),
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('criterionVerifiableByChecker', () => {
  it('is true for criteria that name the static checker domain', () => {
    for (const text of [
      'typecheck passes',
      'tsc reports no type errors',
      'Type check is clean',
      'eslint passes with no warnings',
      'lint is clean',
      'the project builds',
      'it compiles without errors',
      'no type errors remain',
    ]) {
      expect(criterionVerifiableByChecker(text)).toBe(true);
    }
  });

  it('is false (honestly unverified) for behavioral criteria the checker cannot prove', () => {
    for (const text of [
      'endpoint returns 200',
      'no console errors at runtime',
      'the button navigates to the settings page',
      'the user can log in',
      'response time is under 100ms',
      'the modal closes on Escape',
      // Word-boundary + dropped-ambiguous-keyword guards (round-35 review): these
      // contain a keyword as a SUBSTRING but are behavioral, and a bare "no errors"
      // is ambiguous — all must stay unverified, not be stamped from a tsc pass.
      'no errors in the UI',
      'the building list renders',
      'the user can rebuild the index',
      'the flint tool works',
    ]) {
      expect(criterionVerifiableByChecker(text)).toBe(false);
    }
  });
});

describe('guards', () => {
  it('isTaskStatus / isEdgeType', () => {
    expect(isTaskStatus('running')).toBe(true);
    expect(isTaskStatus('nope')).toBe(false);
    expect(isEdgeType('depends_on')).toBe(true);
    expect(isEdgeType('data')).toBe(true);
    expect(isEdgeType('x')).toBe(false);
  });
});

describe('scheduler', () => {
  // a → b → d, a → c → d (diamond)
  const diamond = () =>
    graph([task('a'), task('b'), task('c'), task('d')], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]);

  it('dependenciesOf / dependentsOf follow depends_on direction', () => {
    const g = diamond();
    expect(dependenciesOf(g, 'd').sort()).toEqual(['b', 'c']);
    expect(dependentsOf(g, 'a').sort()).toEqual(['b', 'c']);
    expect(dependenciesOf(g, 'a')).toEqual([]);
  });

  it('readyTasks: only the root when nothing is done', () => {
    expect(readyTasks(diamond()).map((t) => t.id)).toEqual(['a']);
  });

  it('readyTasks: independent upstreams unlock in parallel', () => {
    const g = graph([task('a', 'done'), task('b'), task('c'), task('d')], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]);
    expect(readyTasks(g).map((t) => t.id).sort()).toEqual(['b', 'c']);
  });

  it('readyTasks: a task waits for ALL its upstreams', () => {
    const g = graph([task('a', 'done'), task('b', 'done'), task('c'), task('d')], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]);
    // d depends on b(done) + c(planned) → not ready; c is ready.
    expect(readyTasks(g).map((t) => t.id)).toEqual(['c']);
  });

  it('readyTasks: a running task is not re-offered', () => {
    const g = graph([task('a', 'running'), task('b')], [['a', 'b']]);
    expect(readyTasks(g)).toEqual([]);
  });

  it('blockedTaskIds: a failed upstream blocks downstream transitively', () => {
    const g = graph([task('a', 'failed'), task('b'), task('c')], [['a', 'b'], ['b', 'c']]);
    // b is blocked by failed `a`; c is blocked by the now-blocked `b` (transitive).
    expect([...blockedTaskIds(g)].sort()).toEqual(['b', 'c']);
  });

  it('readyTasks: never auto-runs a decision node or a human executor (manual gate)', () => {
    const g = graph(
      [task('decide', 'planned', { kind: 'decision' }), task('manual', 'planned', { executor: { type: 'human' } }), task('work')],
      [],
    );
    expect(readyTasks(g).map((t) => t.id)).toEqual(['work']);
  });

  it('topologicalOrder respects depends_on', () => {
    const order = topologicalOrder(diamond());
    expect(order).not.toBeNull();
    const pos = (id: string) => order!.indexOf(id);
    expect(pos('a')).toBeLessThan(pos('b'));
    expect(pos('a')).toBeLessThan(pos('c'));
    expect(pos('b')).toBeLessThan(pos('d'));
    expect(pos('c')).toBeLessThan(pos('d'));
  });

  it('parallelLayers groups independent tasks', () => {
    const layers = parallelLayers(diamond());
    expect(layers).not.toBeNull();
    expect(layers![0]).toEqual(['a']);
    expect(layers![1].sort()).toEqual(['b', 'c']); // b and c run in parallel
    expect(layers![2]).toEqual(['d']);
  });

  it('detects cycles', () => {
    const g = graph([task('a'), task('b')], [['a', 'b'], ['b', 'a']]);
    expect(hasCycle(g)).toBe(true);
    expect(topologicalOrder(g)).toBeNull();
    expect(parallelLayers(g)).toBeNull();
  });

  it('ignores edges pointing at missing tasks', () => {
    const g = graph([task('a', 'done'), task('b')], [['a', 'b'], ['ghost', 'b']]);
    expect(readyTasks(g).map((t) => t.id)).toEqual(['b']);
  });
});

describe('parseWorkGraph', () => {
  it('accepts a well-formed graph and drops dangling edges', () => {
    const wg = parseWorkGraph({
      id: 'g1',
      goal: 'ship it',
      tasks: [
        { id: 't1', title: 'A', intent: 'why', kind: 'work', status: 'planned', acceptance: [] },
        { id: 't2', title: 'B' },
      ],
      edges: [
        { from: 't1', to: 't2', type: 'depends_on' },
        { from: 't1', to: 'missing', type: 'depends_on' }, // dropped
        { from: 't2', to: 't2', type: 'data' }, // self → dropped
      ],
    });
    expect(wg).not.toBeNull();
    expect(wg!.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(wg!.edges).toHaveLength(1);
    expect(wg!.edges[0]).toMatchObject({ from: 't1', to: 't2', type: 'depends_on' });
    // Defaults filled.
    expect(wg!.tasks[1].status).toBe('planned');
    expect(wg!.tasks[1].executor).toEqual({ type: 'agent', ref: 'agent' });
  });

  it('rejects empty, non-object, and cyclic graphs', () => {
    expect(parseWorkGraph(null)).toBeNull();
    expect(parseWorkGraph({ tasks: [] })).toBeNull();
    expect(
      parseWorkGraph({
        tasks: [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }],
        edges: [
          { from: 'a', to: 'b', type: 'depends_on' },
          { from: 'b', to: 'a', type: 'depends_on' },
        ],
      }),
    ).toBeNull();
  });

  it('coerces unknown statuses/kinds to safe defaults and keeps acceptance verdicts', () => {
    const wg = parseWorkGraph({
      tasks: [
        {
          id: 't1',
          title: 'A',
          status: 'bogus',
          kind: 'bogus',
          acceptance: [{ id: 'c1', text: 'typecheck passes', verdict: 'pass' } satisfies Partial<Criterion>],
        },
      ],
    });
    expect(wg!.tasks[0].status).toBe('planned');
    expect(wg!.tasks[0].kind).toBe('work');
    expect(wg!.tasks[0].acceptance[0]).toMatchObject({ text: 'typecheck passes', verdict: 'pass' });
  });
});
