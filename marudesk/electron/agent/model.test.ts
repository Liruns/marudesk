import { describe, expect, it } from 'vitest';
import { buildModel } from './model.ts';

/**
 * buildModel routing/guard checks that need no network — constructing an AI SDK
 * model instance is synchronous; the per-request fetch (and any token exchange)
 * only fires when a request is actually made. Focused on gitlab-duo, whose
 * Claude-vs-GPT dialect routing + PAT requirement are easy to regress.
 */
describe('buildModel — gitlab-duo', () => {
  const key = { mode: 'api-key', apiKey: 'glpat-test' } as const;

  it('builds a Claude model (anthropic-dialect proxy) without throwing', () => {
    expect(() => buildModel('gitlab-duo', 'claude-sonnet-4-6', key)).not.toThrow();
  });

  it('builds a GPT model (openai-dialect proxy) without throwing', () => {
    expect(() => buildModel('gitlab-duo', 'gpt-5', key)).not.toThrow();
  });

  it('requires a PAT — rejects an OAuth auth mode', () => {
    expect(() =>
      buildModel('gitlab-duo', 'claude-sonnet-4-6', { mode: 'oauth', accessToken: 't' }),
    ).toThrow(/GitLab access token/i);
  });

  it('requires a non-empty key', () => {
    expect(() => buildModel('gitlab-duo', 'gpt-5', { mode: 'api-key', apiKey: '' })).toThrow(
      /GitLab access token/i,
    );
  });
});
