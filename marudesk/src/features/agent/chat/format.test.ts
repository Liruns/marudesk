import { describe, expect, it } from 'vitest';
import type { AgentRunTreeNode } from '../../../../shared/agent-orchestration';
import { hasOrchestrationContent } from './format';

function node(over: Partial<AgentRunTreeNode> = {}): AgentRunTreeNode {
  return {
    id: 'n',
    parentId: null,
    kind: 'thread',
    label: 'New chat',
    status: 'idle',
    children: [],
    ...over,
  };
}

describe('hasOrchestrationContent', () => {
  it('is false with no nodes', () => {
    expect(hasOrchestrationContent([])).toBe(false);
  });

  it('is false for a single bare childless thread (the steady state)', () => {
    expect(hasOrchestrationContent([node({ id: 'a' })])).toBe(false);
  });

  it('is false for several bare idle threads — that is noise, not orchestration', () => {
    // Regression: two idle "New chat" threads used to surface an empty Agent tree
    // card in the dock chat. A flat list of childless threads is not orchestration.
    expect(
      hasOrchestrationContent([node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c' })]),
    ).toBe(false);
  });

  it('is true once a thread actually branches (has children)', () => {
    expect(
      hasOrchestrationContent([
        node({ id: 'root', children: [node({ id: 'child', parentId: 'root' })] }),
      ]),
    ).toBe(true);
  });

  it('is true for a spawned background agent', () => {
    expect(
      hasOrchestrationContent([node({ id: 'a' }), node({ id: 'bg', kind: 'background-agent' })]),
    ).toBe(true);
  });
});
