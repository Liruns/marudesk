import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * The OpenAI-compatible API-key providers absorbed from the reference ecosystems
 * (docs/provider-expansion-plan.md): OpenRouter / Groq / Cerebras / Mistral /
 * DeepSeek. They have no OAuth path, so they should report as not-connected
 * (hasKey:false, no oauth) on a fresh profile, and `providers:list-models` should
 * return their static seed catalog without a key (no network — the driver only
 * fires once a key is stored).
 */

const ABSORBED = ['openrouter', 'groq', 'cerebras', 'mistral', 'deepseek'] as const;

test('providers: absorbed API-key providers are present and start unconfigured', async () => {
  const { app, page } = await launchApp();
  try {
    const status = await page.evaluate(() =>
      window.marudesk.invoke('secrets:list-providers'),
    );
    for (const id of ABSORBED) {
      const ps = status.find((s) => s.id === id);
      expect(ps, `${id} should be a built-in provider`).toBeTruthy();
      expect(ps?.hasKey ?? false).toBe(false);
      // API-key only — never an OAuth connection.
      expect(ps?.oauth ?? false).toBe(false);
    }
  } finally {
    await app.close();
  }
});

test('providers: absorbed providers seed the picker without a key', async () => {
  const { app, page } = await launchApp();
  try {
    for (const id of ABSORBED) {
      const models = await page.evaluate(
        (p) => window.marudesk.invoke('providers:list-models', p),
        id,
      );
      expect(Array.isArray(models)).toBe(true);
      expect(models.length, `${id} should seed at least one model`).toBeGreaterThan(0);
    }
  } finally {
    await app.close();
  }
});

test('providers: absorbed providers have no OAuth login support', async () => {
  const { app, page } = await launchApp();
  try {
    const err = await page.evaluate(async () => {
      try {
        await window.marudesk.invoke('auth:oauth-start', 'openrouter');
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(err).toContain('does not support OAuth');
  } finally {
    await app.close();
  }
});
