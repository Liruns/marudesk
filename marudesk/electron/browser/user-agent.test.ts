import { describe, expect, it } from 'vitest';
import { buildWebTabUserAgent } from './user-agent.ts';

const WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) marudesk/0.0.3 Chrome/148.0.0.0 Electron/42.3.3 Safari/537.36';

describe('buildWebTabUserAgent', () => {
  it('strips the Electron and app tokens, keeping the real Chrome version', () => {
    expect(buildWebTabUserAgent(WIN, 'marudesk')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    );
  });

  it('does not forge the Chrome version (keeps the bundled engine version)', () => {
    const out = buildWebTabUserAgent(WIN, 'marudesk');
    expect(out).toContain('Chrome/148.0.0.0');
    expect(out).not.toMatch(/Electron/i);
    expect(out).not.toContain('marudesk');
  });

  it('is idempotent — re-running on a cleaned UA is a no-op', () => {
    const once = buildWebTabUserAgent(WIN, 'marudesk');
    expect(buildWebTabUserAgent(once, 'marudesk')).toBe(once);
  });

  it('tolerates a missing app token', () => {
    const noApp =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Electron/42.3.3 Safari/537.36';
    expect(buildWebTabUserAgent(noApp, 'marudesk')).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    );
  });

  it('escapes regex-special characters in the app name', () => {
    const ua =
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) my.app+x/1.2.3 Chrome/148.0.0.0 Electron/42.3.3 Safari/537.36';
    const out = buildWebTabUserAgent(ua, 'my.app+x');
    expect(out).not.toContain('my.app+x');
    expect(out).toContain('Chrome/148.0.0.0');
  });
});
