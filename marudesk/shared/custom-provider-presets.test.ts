import { describe, expect, it } from 'vitest';
import { CUSTOM_ENDPOINT_PRESETS } from './custom-provider-presets.ts';
import { PROVIDERS } from './provider-catalog.ts';

/**
 * Data-integrity guards for the provider quick-setup surfaces. These tables are
 * hand-maintained from the reference catalog + provider docs, so the cheapest
 * way to catch a fat-fingered URL / duplicate id is to assert their shape here.
 */

function isParseableUrl(value: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

describe('custom endpoint presets', () => {
  it('have unique ids', () => {
    const ids = CUSTOM_ENDPOINT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declare a parseable base URL with no trailing slash', () => {
    for (const preset of CUSTOM_ENDPOINT_PRESETS) {
      expect(isParseableUrl(preset.baseUrl), `${preset.id} baseUrl`).toBe(true);
      expect(preset.baseUrl.endsWith('/'), `${preset.id} trailing slash`).toBe(false);
    }
  });

  it('pair key URLs with cloud presets and keylessness with local runtimes', () => {
    for (const preset of CUSTOM_ENDPOINT_PRESETS) {
      if (preset.local) {
        // Local runtimes need no key and run over loopback.
        expect(preset.apiKeyUrl, `${preset.id} should be keyless`).toBeUndefined();
        expect(preset.baseUrl, `${preset.id} should be loopback`).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1)/);
      } else {
        // Cloud gateways point at an https console to issue a key.
        expect(preset.apiKeyUrl, `${preset.id} needs a key URL`).toBeTruthy();
        expect(preset.apiKeyUrl?.startsWith('https://'), `${preset.id} key URL https`).toBe(true);
        expect(preset.baseUrl.startsWith('https://'), `${preset.id} cloud https`).toBe(true);
      }
    }
  });

  it('do not duplicate a first-class built-in provider id', () => {
    const builtins = new Set(PROVIDERS.map((p) => p.id as string));
    for (const preset of CUSTOM_ENDPOINT_PRESETS) {
      expect(builtins.has(preset.id), `${preset.id} collides with a built-in`).toBe(false);
    }
  });
});

describe('built-in provider apiKeyUrl', () => {
  it('is a valid https URL wherever set', () => {
    for (const provider of PROVIDERS) {
      if (provider.apiKeyUrl === undefined) continue;
      expect(isParseableUrl(provider.apiKeyUrl), `${provider.id} apiKeyUrl`).toBe(true);
      expect(provider.apiKeyUrl.startsWith('https://'), `${provider.id} https`).toBe(true);
    }
  });

  it('is omitted for OAuth-only and keyless providers', () => {
    for (const provider of PROVIDERS) {
      if (provider.oauthOnly || provider.keyless) {
        expect(provider.apiKeyUrl, `${provider.id} should have no key URL`).toBeUndefined();
      }
    }
  });

  it('is present for the standard API-key providers', () => {
    const expectKey = ['anthropic', 'openai', 'google', 'openrouter', 'groq', 'deepseek'];
    for (const id of expectKey) {
      const provider = PROVIDERS.find((p) => p.id === id);
      expect(provider?.apiKeyUrl, `${id} apiKeyUrl`).toBeTruthy();
    }
  });
});
