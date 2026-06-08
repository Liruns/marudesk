import { describe, expect, it } from 'vitest';
import type { AgentToolInfo } from '../../../shared/agent';
import { applyGroupToggle, isGroupEnabled, toolsInGroup } from './tool-groups';

const tools: AgentToolInfo[] = [
  { name: 'click', group: 'browser', gated: false, requiresWeb: true },
  { name: 'eval_js', group: 'browser', gated: true, requiresWeb: true },
  { name: 'run_command', group: 'terminal', gated: true, requiresWeb: false },
  { name: 'read_file', group: 'files', gated: false, requiresWeb: false },
];

describe('tool-groups', () => {
  it('lists tool names in a group', () => {
    expect(toolsInGroup(tools, 'browser')).toEqual(['click', 'eval_js']);
    expect(toolsInGroup(tools, 'terminal')).toEqual(['run_command']);
    expect(toolsInGroup(tools, 'nope')).toEqual([]);
  });

  it('reports a group enabled only when none of its tools are denied', () => {
    expect(isGroupEnabled([], ['click', 'eval_js'])).toBe(true);
    expect(isGroupEnabled(['eval_js'], ['click', 'eval_js'])).toBe(false);
    expect(isGroupEnabled(['eval_js'], [])).toBe(true); // empty group is vacuously on
  });

  it('disabling a group adds every tool name to the deny list (no dupes)', () => {
    const next = applyGroupToggle(['run_command'], ['click', 'eval_js'], false);
    expect(next.sort()).toEqual(['click', 'eval_js', 'run_command']);
    // Idempotent — toggling off again doesn't duplicate.
    expect(applyGroupToggle(next, ['click', 'eval_js'], false).sort()).toEqual(next.sort());
  });

  it('enabling a group removes exactly its tool names, leaving others', () => {
    const next = applyGroupToggle(['click', 'eval_js', 'run_command'], ['click', 'eval_js'], true);
    expect(next).toEqual(['run_command']);
  });
});
