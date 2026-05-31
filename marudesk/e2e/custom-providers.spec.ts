import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Custom OpenAI-compatible endpoints (docs/agentic-chat-v2-design.md §5). The
 * config (label / baseURL / models) round-trips through the `providers:*` IPC and
 * the plaintext store. The optional-key path is NOT exercised here — safeStorage
 * may be unavailable headless — so every endpoint added below is key-less, which
 * never touches the encrypted creds vault.
 */

test('custom providers: add → list → remove round-trips (no key)', async () => {
  const { app, page } = await launchApp();
  try {
    const initial = await page.evaluate(() =>
      window.marudesk.invoke('providers:list-custom'),
    );
    expect(initial).toEqual([]);

    const afterAdd = await page.evaluate(() =>
      window.marudesk.invoke('providers:add-custom', {
        label: 'OpenRouter Test',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelIds: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5'],
      }),
    );
    expect(afterAdd).toHaveLength(1);
    const entry = afterAdd[0];
    expect(entry.id).toBe('openrouter-test');
    expect(entry.label).toBe('OpenRouter Test');
    expect(entry.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(entry.kind).toBe('openai-compatible');
    expect(entry.models.map((m) => m.id)).toEqual([
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-5',
    ]);
    expect(entry.hasKey).toBe(false);

    const listed = await page.evaluate(() =>
      window.marudesk.invoke('providers:list-custom'),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('openrouter-test');

    const afterRemove = await page.evaluate(() =>
      window.marudesk.invoke('providers:remove-custom', 'openrouter-test'),
    );
    expect(afterRemove).toEqual([]);
  } finally {
    await app.close();
  }
});

test('custom providers: a bad base URL is rejected', async () => {
  const { app, page } = await launchApp();
  try {
    const err = await page.evaluate(async () => {
      try {
        await window.marudesk.invoke('providers:add-custom', {
          label: 'Bad',
          baseUrl: 'not-a-url',
          modelIds: ['x'],
        });
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(err).toBeTruthy();
    expect(err).toContain('baseUrl');
  } finally {
    await app.close();
  }
});

test('custom providers: an empty model list is rejected', async () => {
  const { app, page } = await launchApp();
  try {
    const err = await page.evaluate(async () => {
      try {
        await window.marudesk.invoke('providers:add-custom', {
          label: 'NoModels',
          baseUrl: 'http://localhost:1234/v1',
          modelIds: [],
        });
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(err).toBeTruthy();
  } finally {
    await app.close();
  }
});

test('custom providers: a trailing slash on the base URL is normalized', async () => {
  const { app, page } = await launchApp();
  try {
    const added = await page.evaluate(() =>
      window.marudesk.invoke('providers:add-custom', {
        label: 'vLLM',
        baseUrl: 'http://localhost:8000/v1/',
        modelIds: ['my-model'],
      }),
    );
    expect(added[0].baseUrl).toBe('http://localhost:8000/v1');
  } finally {
    await app.close();
  }
});
