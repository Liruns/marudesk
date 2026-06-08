import { describe, expect, it } from 'vitest';
import type { AgentMessage, ToolCall } from '../../../../shared/agent';
import type { ConsoleEntry, NetworkEntry } from '../types';
import { buildAgentRows, buildProblemRows } from './evidence-rows';

/**
 * Page-action timeline rows (docs/runtime-agent-absorption-2026-06.md §3.3/§3.5).
 * buildAgentRows derives the agent's live-page actions purely from the chat
 * transcript's tool calls — no main-side plumbing — so it's unit-testable.
 */

function tool(call: Partial<ToolCall> & { name: string; id: string }): AgentMessage {
  return {
    id: `m-${call.id}`,
    role: 'assistant',
    timestamp: 1000,
    parts: [{ type: 'tool', call: { input: {}, state: 'ok', ...call } }],
  };
}

describe('buildAgentRows', () => {
  it('includes only page-action tools, mapping name + args', () => {
    const messages: AgentMessage[] = [
      tool({ id: '1', name: 'click', input: { selector: '#submit' } }),
      tool({ id: '2', name: 'read_file', input: { path: 'a.ts' } }), // not a page action
      tool({ id: '3', name: 'fill', input: { selector: '#email', value: 'a@b.com' } }),
    ];
    const rows = buildAgentRows(messages);
    expect(rows.map((r) => r.label)).toEqual(['click', 'fill']);
    expect(rows[0]).toMatchObject({ source: 'agent', refId: '1', variant: 'accent', actionable: false });
    expect(rows[0]!.summary).toBe('#submit');
    expect(rows[1]!.summary).toBe('#email = a@b.com');
  });

  it('prefers the tool call summary when present', () => {
    const rows = buildAgentRows([
      tool({ id: '9', name: 'scroll', input: { direction: 'down' }, summary: 'scrolled to footer' }),
    ]);
    expect(rows[0]!.summary).toBe('scrolled to footer');
  });

  it('marks failed/denied/aborted actions as error rows', () => {
    const rows = buildAgentRows([
      tool({ id: 'e', name: 'click', input: { selector: '.x' }, state: 'error' }),
      tool({ id: 'd', name: 'fill', input: { selector: '.y', value: 'z' }, state: 'denied' }),
      tool({ id: 'o', name: 'query_dom', input: { selector: '.z' }, state: 'ok' }),
    ]);
    expect(rows.map((r) => r.variant)).toEqual(['error', 'error', 'accent']);
  });

  it('ignores non-tool parts', () => {
    const messages: AgentMessage[] = [
      { id: 'm', role: 'assistant', timestamp: 1, parts: [{ type: 'text', text: 'hi' }] },
    ];
    expect(buildAgentRows(messages)).toEqual([]);
  });
});

describe('problem + action merge ordering', () => {
  it('sorts every source onto one wall-clock axis, newest first', () => {
    const console: ConsoleEntry[] = [
      { id: 'c1', kind: 'error', text: 'boom', args: [], timestamp: 3000 } as ConsoleEntry,
    ];
    const network: NetworkEntry[] = [
      { requestId: 'n1', method: 'GET', url: 'http://x/api', status: 500, failed: false, wallTime: 1000 } as NetworkEntry,
    ];
    const agent: AgentMessage[] = [
      { id: 'm', role: 'assistant', timestamp: 2000, parts: [{ type: 'tool', call: { id: 'a1', name: 'click', input: { selector: '#a' }, state: 'ok' } }] },
    ];
    const merged = [...buildProblemRows(console, network), ...buildAgentRows(agent)].sort((a, b) => b.t - a.t);
    expect(merged.map((r) => r.source)).toEqual(['console', 'agent', 'network']);
  });
});
