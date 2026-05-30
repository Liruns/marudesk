import { test, expect } from '@playwright/test';
import { REDACTED, scrubHeaders, scrubText } from '../shared/scrub';

/**
 * Pure unit coverage for the secret-scrub (P0.5) — the security gate on every
 * page-data egress to the LLM. Runs in the Playwright worker (Node); no Electron
 * launch. A regression here can leak credentials, so the bar is "recognized
 * secret never survives".
 */

test('scrub: bare "Bearer <token>" in prose keeps the scheme, redacts the credential', () => {
  const out = scrubText('the request sent Bearer abcDEF1234567890ghijkl upstream');
  expect(out).not.toContain('abcDEF1234567890ghijkl');
  expect(out).toContain('Bearer');
  expect(out).toContain(REDACTED);
});

test('scrub: "Authorization: Bearer <token>" is fully redacted (key-value rule wins)', () => {
  // When the credential is introduced by an `authorization:` key, the whole
  // value is redacted — safer than preserving the scheme, which is fine.
  const out = scrubText('Authorization: Bearer abcDEF1234567890ghijkl');
  expect(out).not.toContain('abcDEF1234567890ghijkl');
  expect(out).toContain(REDACTED);
});

test('scrub: redacts provider keys (sk-, sk-ant-, AIza, gh*, AKIA)', () => {
  const cases = [
    'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
    'sk-proj-BBBBBBBBBBBBBBBBBBBB',
    'AIzaSyAAAAAAAAAAAAAAAAAAAAAAA',
    'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AKIAIOSFODNN7EXAMPLE',
  ];
  for (const secret of cases) {
    const out = scrubText(`token=${secret} trailing`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
    expect(out).toContain('trailing'); // surrounding text survives
  }
});

test('scrub: redacts JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const out = scrubText(`bearer is ${jwt}`);
  expect(out).not.toContain(jwt);
  expect(out).toContain(REDACTED);
});

test('scrub: redacts key=value secrets, keeps the key name', () => {
  const out = scrubText('{"api_key":"supersecretvalue123","page":2}');
  expect(out).not.toContain('supersecretvalue123');
  expect(out).toContain('api_key');
  expect(out).toContain('"page":2'); // non-secret fields untouched
});

test('scrub: redacts env-var style prefixed secret keys (underscore boundary)', () => {
  for (const line of [
    'aws_secret=AKIAvalueShouldVanish01',
    'DB_PASSWORD=abcd1234secret',
    'my_password=abcd1234secret',
    'user_token=abcd1234secret',
    'token=abcd1234secret',
  ]) {
    const out = scrubText(line);
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(/abcd1234secret|AKIAvalueShouldVanish01/);
  }
});

test('scrub: redacts dotted Google OAuth, npm tokens, and PEM private keys', () => {
  expect(scrubText('ya29.A0ARrdaM-longRefreshTokenValueHere1234')).toContain(REDACTED);
  expect(scrubText('npm_abcdefghijklmnopqrstuvwxyz0123456789')).toContain(REDACTED);
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc123def456\n-----END RSA PRIVATE KEY-----';
  const out = scrubText(`key:\n${pem}`);
  expect(out).not.toContain('MIIabc123def456');
  expect(out).toContain(REDACTED);
});

test('scrub: masks email local part, keeps domain', () => {
  const out = scrubText('contact alice@example.com for help');
  expect(out).not.toContain('alice@example.com');
  expect(out).toContain('@example.com');
});

test('scrub: leaves ordinary prose alone', () => {
  const text = 'TypeError: cannot read property foo of undefined at App.tsx:42';
  expect(scrubText(text)).toBe(text);
});

test('scrubHeaders: redacts sensitive header values wholesale', () => {
  const out = scrubHeaders({
    authorization: 'Bearer abcDEF1234567890ghijkl',
    cookie: 'session=deadbeefdeadbeef',
    'content-type': 'application/json',
  });
  expect(out.authorization).toBe(REDACTED);
  expect(out.cookie).toBe(REDACTED);
  expect(out['content-type']).toBe('application/json');
});

test('scrub: total and defensive on non-strings', () => {
  expect(scrubText(undefined)).toBe('');
  expect(scrubText(123 as unknown)).toBe('');
  expect(scrubHeaders(null)).toEqual({});
});
