import { describe, it, expect } from 'vitest';
import { isSensitiveEnvName, stripSensitiveEnv } from './proc-env';

/**
 * Unit coverage for the centralized inherit-minus-secrets filter. Asserts the
 * widened SENSITIVE_ENV pattern strips the credential var names a real machine
 * carries (AWS/GCP keys, *_PASS, *_CREDENTIALS, bare PASSWORD/TOKEN) while
 * leaving the benign vars a spawned shell genuinely needs (PATH/HOME/TEMP/
 * SystemRoot), non-secret provider CONFIG the suffix rules must NOT eat
 * (AWS_REGION, GITHUB_REPOSITORY, OPENAI_BASE_URL), and near-miss lookalikes
 * (KEYBOARD, MONKEY) alone.
 * stripSensitiveEnv takes an explicit source so the test never depends on the
 * ambient process.env.
 */

describe('isSensitiveEnvName', () => {
  it('strips credential-shaped names', () => {
    const sensitive = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'STRIPE_KEY',
      'DB_PASS',
      'DB_PASSWORD',
      'MY_PRIVATE_KEY',
      'SSH_PRIVATE_KEY',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'SOME_SECRET',
      'FOO_CREDENTIAL',
      'FOO_CREDENTIALS',
      'AZURE_CLIENT_SECRET',
      'GCP_API_KEY',
      'PASSWORD',
      'TOKEN',
      'SECRET',
    ];
    for (const name of sensitive) {
      expect(isSensitiveEnvName(name), name).toBe(true);
    }
  });

  it('keeps benign names a spawned shell needs', () => {
    const benign = [
      'PATH',
      'HOME',
      'USER',
      'USERPROFILE',
      'TEMP',
      'TMP',
      'SystemRoot',
      'ComSpec',
      'PATHEXT',
      'SHELL',
      'LANG',
      'TERM',
      'PWD',
      'NODE_ENV',
      'PROCESSOR_ARCHITECTURE',
      'NUMBER_OF_PROCESSORS',
      // Non-secret provider CONFIG: real tooling reads these, and stripping on a
      // bare provider prefix would silently change region/endpoint/profile.
      'AWS_REGION',
      'AWS_PROFILE',
      'AWS_DEFAULT_REGION',
      'GITHUB_REPOSITORY',
      'GITHUB_WORKSPACE',
      'OPENAI_BASE_URL',
      'GOOGLE_CLOUD_PROJECT',
      'AZURE_TENANT_ID',
      // Near-miss lookalikes: no `_`-bounded secret segment, must survive.
      'KEYBOARD',
      'MONKEY',
      'PASSAGE',
      'BYPASS',
      'TOKENIZER',
    ];
    for (const name of benign) {
      expect(isSensitiveEnvName(name), name).toBe(false);
    }
  });
});

describe('stripSensitiveEnv', () => {
  it('drops secret-shaped keys but preserves the rest', () => {
    const result = stripSensitiveEnv({
      PATH: '/usr/bin',
      HOME: '/home/me',
      ANTHROPIC_API_KEY: 'sk-secret',
      AWS_ACCESS_KEY_ID: 'AKIA123',
      DB_PASSWORD: 'hunter2',
      KEYBOARD: 'qwerty',
    });
    expect(result).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      KEYBOARD: 'qwerty',
    });
  });

  it('ignores non-string values', () => {
    const result = stripSensitiveEnv({ PATH: '/usr/bin', MISSING: undefined });
    expect(result).toEqual({ PATH: '/usr/bin' });
  });
});
