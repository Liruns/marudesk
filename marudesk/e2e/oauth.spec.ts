import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * OAuth subscription login IPC contract (docs/oauth-providers-design.md). The real
 * flow needs a Claude account + browser, so these exercise the guard/validation
 * surface only — deliberately NOT calling `auth:oauth-start` for a supported
 * provider, since that opens the system browser. None of the assertions below
 * touch the encrypted vault (safeStorage may be unavailable headless): a fresh
 * profile has no creds file, and disconnect on a not-connected provider returns
 * early before any write.
 */

test('oauth: anthropic starts disconnected; non-oauth providers report no oauth', async () => {
  const { app, page } = await launchApp();
  try {
    const status = await page.evaluate(() =>
      window.marudesk.invoke('secrets:list-providers'),
    );
    const byId = (id: string) => status.find((s) => s.id === id);
    expect(byId('anthropic')?.oauth ?? false).toBe(false);
    // OAuth-capable providers start disconnected.
    for (const id of ['xai', 'openai-codex', 'google-caa']) {
      expect(byId(id)?.oauth ?? false).toBe(false);
      expect(byId(id)?.hasKey ?? false).toBe(false);
    }
    // The API-key openai/google providers have no OAuth support.
    expect(byId('openai')?.oauth ?? false).toBe(false);
    expect(byId('google')?.oauth ?? false).toBe(false);
  } finally {
    await app.close();
  }
});

test('oauth: start/complete/disconnect reject providers without OAuth support', async () => {
  const { app, page } = await launchApp();
  try {
    const errors = await page.evaluate(async () => {
      const grab = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      };
      return {
        start: await grab(() => window.marudesk.invoke('auth:oauth-start', 'openai')),
        complete: await grab(() =>
          window.marudesk.invoke('auth:oauth-complete', { provider: 'openai', pasted: 'x#y' }),
        ),
        cancel: await grab(() => window.marudesk.invoke('auth:oauth-cancel', 'openai')),
        disconnect: await grab(() => window.marudesk.invoke('auth:oauth-disconnect', 'openai')),
      };
    });
    expect(errors.start).toContain('does not support OAuth');
    expect(errors.complete).toContain('does not support OAuth');
    expect(errors.cancel).toContain('does not support OAuth');
    expect(errors.disconnect).toContain('does not support OAuth');
  } finally {
    await app.close();
  }
});

test('oauth: complete without a started flow is rejected (no pending PKCE)', async () => {
  const { app, page } = await launchApp();
  try {
    const err = await page.evaluate(async () => {
      try {
        await window.marudesk.invoke('auth:oauth-complete', {
          provider: 'anthropic',
          pasted: 'some-code#some-state',
        });
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(err).toBeTruthy();
    expect(err).toContain('again');
  } finally {
    await app.close();
  }
});

test('oauth: disconnect on a not-connected provider is idempotent', async () => {
  const { app, page } = await launchApp();
  try {
    const ok = await page.evaluate(() =>
      window.marudesk.invoke('auth:oauth-disconnect', 'anthropic'),
    );
    expect(ok).toBe(true);
  } finally {
    await app.close();
  }
});

// The loopback-flow providers (xAI + the OAuth-only openai-codex / google-caa). We
// deliberately never call `auth:oauth-start` for them here — that binds a local
// port and opens a real browser — so we cover the no-side-effect surface:
// complete-without-start, and idempotent cancel/disconnect.
for (const provider of ['xai', 'openai-codex', 'google-caa'] as const) {
  test(`oauth: ${provider} (loopback) — complete-without-start rejected; cancel/disconnect idempotent`, async () => {
    const { app, page } = await launchApp();
    try {
      const r = await page.evaluate(async (p) => {
        const grab = async (fn: () => Promise<unknown>) => {
          try {
            return { ok: await fn() };
          } catch (e) {
            return { err: (e as Error).message };
          }
        };
        return {
          completeNoStart: await grab(() =>
            window.marudesk.invoke('auth:oauth-complete', { provider: p, pasted: 'a#b' }),
          ),
          cancel: await grab(() => window.marudesk.invoke('auth:oauth-cancel', p)),
          disconnect: await grab(() => window.marudesk.invoke('auth:oauth-disconnect', p)),
        };
      }, provider);
      expect((r.completeNoStart as { err?: string }).err).toContain('again');
      expect((r.cancel as { ok?: unknown }).ok).toBe(true);
      expect((r.disconnect as { ok?: unknown }).ok).toBe(true);
    } finally {
      await app.close();
    }
  });
}
