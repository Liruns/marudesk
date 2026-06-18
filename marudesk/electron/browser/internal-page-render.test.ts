import { describe, expect, it } from 'vitest';
import {
  errorHeadline,
  escapeHtml,
  hostOf,
  renderErrorPage,
  renderNewTab,
} from './internal-page-render';

describe('internal page renderers', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;',
    );
  });

  it('hostOf returns the host, falling back to the raw string', () => {
    expect(hostOf('https://example.com:8080/path')).toBe('example.com:8080');
    expect(hostOf('not a url')).toBe('not a url');
  });

  it('maps known net error codes to specific copy', () => {
    expect(
      errorHeadline({ failedUrl: 'https://x.dev', code: -105, description: '' }),
    ).toContain('doesn’t resolve');
    expect(
      errorHeadline({ failedUrl: '', code: -106, description: '' }),
    ).toBe('You appear to be offline.');
    expect(
      errorHeadline({ failedUrl: 'https://x.dev', code: -999, description: '' }),
    ).toContain('Can’t reach');
  });

  it('renders a retry link for http(s) targets and never for others', () => {
    const ok = renderErrorPage(
      { failedUrl: 'https://x.dev/a', code: -7, description: 'ERR_TIMED_OUT' },
      'https://www.google.com/search?q=x.dev',
    );
    expect(ok).toContain('href="https://x.dev/a"');
    expect(ok).toContain('Search instead');

    const noRetry = renderErrorPage(
      { failedUrl: 'ftp://x.dev', code: -2, description: '' },
      'https://www.google.com/search?q=x.dev',
    );
    expect(noRetry).not.toContain('class="btn primary"');
  });

  it('escapes an injected failed URL into the error page', () => {
    const html = renderErrorPage(
      {
        failedUrl: 'https://x.dev/"><script>alert(1)</script>',
        code: -2,
        description: '',
      },
      'https://www.google.com/search?q=x',
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders the new-tab greeting', () => {
    expect(renderNewTab()).toContain('marudesk');
  });
});
