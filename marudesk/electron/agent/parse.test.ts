import { describe, expect, it } from 'vitest';
import { parseSendInput } from './parse';

const base = { provider: 'anthropic', model: 'claude-x', prompt: 'hi', captures: [] };

describe('parseSendInput connections', () => {
  it('parses valid connections with optional locator', () => {
    const out = parseSendInput({
      ...base,
      connections: [
        { kind: 'editor', title: 'app.tsx', locator: '/src/app.tsx' },
        { kind: 'web', title: 'Stripe', locator: 'https://stripe.com' },
        { kind: 'terminal', title: 'bash' },
      ],
    });
    expect(out.connections).toEqual([
      { kind: 'editor', title: 'app.tsx', locator: '/src/app.tsx' },
      { kind: 'web', title: 'Stripe', locator: 'https://stripe.com' },
      { kind: 'terminal', title: 'bash' },
    ]);
  });

  it('drops malformed entries (missing kind/title, non-string locator)', () => {
    const out = parseSendInput({
      ...base,
      connections: [
        { kind: 'editor' }, // no title → dropped
        { title: 'x' }, // no kind → dropped
        42, // not an object → dropped
        { kind: 'web', title: 'ok', locator: 123 }, // bad locator → kept, no locator
      ],
    });
    expect(out.connections).toEqual([{ kind: 'web', title: 'ok' }]);
  });

  it('treats absent / empty / non-array connections as undefined', () => {
    expect(parseSendInput(base).connections).toBeUndefined();
    expect(parseSendInput({ ...base, connections: [] }).connections).toBeUndefined();
    expect(parseSendInput({ ...base, connections: 'nope' }).connections).toBeUndefined();
  });

  it('caps the list so the preamble cannot balloon', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ kind: 'web', title: `t${i}` }));
    const out = parseSendInput({ ...base, connections: many });
    expect(out.connections).toHaveLength(24);
  });
});
