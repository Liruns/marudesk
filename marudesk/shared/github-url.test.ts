import { describe, expect, it } from 'vitest';
import { buildCompareUrl, parseGitHubRepo } from './github-url';

describe('parseGitHubRepo', () => {
  it('parses ssh + https remotes (with/without .git)', () => {
    expect(parseGitHubRepo('git@github.com:liruns/marudesk.git')).toEqual({ owner: 'liruns', repo: 'marudesk' });
    expect(parseGitHubRepo('https://github.com/liruns/marudesk.git')).toEqual({ owner: 'liruns', repo: 'marudesk' });
    expect(parseGitHubRepo('https://github.com/liruns/marudesk')).toEqual({ owner: 'liruns', repo: 'marudesk' });
  });
  it('returns null for non-GitHub remotes', () => {
    expect(parseGitHubRepo('git@gitlab.com:x/y.git')).toBeNull();
    expect(parseGitHubRepo('')).toBeNull();
  });
});

describe('buildCompareUrl', () => {
  it('builds an expand=1 compare URL, encoding slashy branch names', () => {
    expect(buildCompareUrl('git@github.com:liruns/marudesk.git', 'main', 'marudesk/agent/1')).toBe(
      'https://github.com/liruns/marudesk/compare/main...marudesk%2Fagent%2F1?expand=1',
    );
  });
  it('returns null for a non-GitHub remote', () => {
    expect(buildCompareUrl('git@gitlab.com:x/y.git', 'main', 'b')).toBeNull();
  });
});
