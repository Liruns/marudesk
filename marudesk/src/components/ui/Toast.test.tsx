// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Toast } from './Toast';
import { ToastHost } from '../ToastHost';
import { I18nProvider } from '../../i18n/I18nProvider';
import { useToastStore } from '../../lib/toast';

afterEach(() => {
  cleanup();
  // Drain the global toast store so cases don't leak into each other.
  useToastStore.setState({ toasts: [] });
});

describe('Toast a11y', () => {
  it('announces error toasts assertively via role=alert', () => {
    render(
      <I18nProvider>
        <Toast title="Boom" variant="error" />
      </I18nProvider>,
    );
    const node = screen.getByRole('alert');
    expect(node.getAttribute('aria-live')).toBe('assertive');
  });

  it('keeps non-error toasts polite via role=status', () => {
    render(
      <I18nProvider>
        <Toast title="Saved" variant="success" />
      </I18nProvider>,
    );
    const node = screen.getByRole('status');
    expect(node.getAttribute('aria-live')).toBe('polite');
  });
});

describe('ToastHost', () => {
  it('renders a persistent container even when there are no toasts', () => {
    const { container } = render(
      <I18nProvider>
        <ToastHost />
      </I18nProvider>,
    );
    // A stable region must exist before content changes, so SRs can pick up
    // toasts that appear later. Previously the host returned null when empty.
    expect(container.firstElementChild).not.toBeNull();
  });
});
