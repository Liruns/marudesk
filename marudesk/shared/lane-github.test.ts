import { describe, expect, it } from 'vitest';
import { parsePullForBranch, summarizeCheckRuns } from './lane-github';

const pull = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 7,
  title: 'Fix the thing',
  html_url: 'https://github.com/o/r/pull/7',
  state: 'open',
  draft: false,
  merged_at: null,
  head: { sha: 'abc123' },
  ...over,
});

describe('parsePullForBranch', () => {
  it('parses the newest PR with its head sha', () => {
    expect(parsePullForBranch([pull()])).toEqual({
      number: 7,
      title: 'Fix the thing',
      url: 'https://github.com/o/r/pull/7',
      state: 'open',
      headSha: 'abc123',
    });
  });
  it('maps draft / merged / closed states', () => {
    expect(parsePullForBranch([pull({ draft: true })])?.state).toBe('draft');
    expect(parsePullForBranch([pull({ state: 'closed', merged_at: '2026-06-01T00:00:00Z' })])?.state).toBe('merged');
    expect(parsePullForBranch([pull({ state: 'closed' })])?.state).toBe('closed');
  });
  it('returns null for no PR or a malformed payload', () => {
    expect(parsePullForBranch([])).toBeNull();
    expect(parsePullForBranch({ message: 'rate limited' })).toBeNull();
    expect(parsePullForBranch([{ number: 'x' }])).toBeNull();
  });
});

const run = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/o/r/runs/1',
  ...over,
});

describe('summarizeCheckRuns', () => {
  it('aggregates all-green runs to success', () => {
    expect(summarizeCheckRuns({ check_runs: [run(), run({ conclusion: 'skipped' })] })).toEqual({
      state: 'success',
      total: 2,
      failed: 0,
      url: 'https://github.com/o/r/runs/1',
    });
  });
  it('any failed conclusion wins and points at the failed run', () => {
    const summary = summarizeCheckRuns({
      check_runs: [
        run(),
        run({ conclusion: 'failure', html_url: 'https://github.com/o/r/runs/9' }),
        run({ status: 'in_progress', conclusion: null }),
      ],
    });
    expect(summary).toEqual({ state: 'failure', total: 3, failed: 1, url: 'https://github.com/o/r/runs/9' });
  });
  it('non-completed runs (without failures) mean pending', () => {
    expect(summarizeCheckRuns({ check_runs: [run({ status: 'queued', conclusion: null })] })?.state).toBe('pending');
  });
  it('returns null when the commit has no check runs or the payload is malformed', () => {
    expect(summarizeCheckRuns({ check_runs: [] })).toBeNull();
    expect(summarizeCheckRuns({ total_count: 0 })).toBeNull();
    expect(summarizeCheckRuns('nope')).toBeNull();
  });
});
