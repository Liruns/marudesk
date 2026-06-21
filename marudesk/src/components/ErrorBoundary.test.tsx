// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { I18nProvider } from '../i18n/I18nProvider';
import { EN_MESSAGES } from '../i18n/messages.en';

function Boom(): never {
  throw new Error('kaboom');
}

function renderInProvider(node: ReactNode) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // The boundary logs the caught error via componentDidCatch; React also
    // re-throws to the console during the failed render. Silence both so the
    // expected throw doesn't pollute test output.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the localized fallback (title + reload) when a child throws', () => {
    renderInProvider(
      <ErrorBoundary label="test">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(EN_MESSAGES['errorBoundary.title'])).toBeTruthy();
    expect(
      screen.getByRole('button', { name: EN_MESSAGES['errorBoundary.reload'] }),
    ).toBeTruthy();
  });

  it('renders children unchanged when nothing throws', () => {
    renderInProvider(
      <ErrorBoundary>
        <span>healthy child</span>
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy child')).toBeTruthy();
    expect(screen.queryByText(EN_MESSAGES['errorBoundary.title'])).toBeNull();
  });

  it('uses a custom fallback when provided', () => {
    renderInProvider(
      <ErrorBoundary fallback={(err) => <span>custom: {err.message}</span>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('custom: kaboom')).toBeTruthy();
  });
});
