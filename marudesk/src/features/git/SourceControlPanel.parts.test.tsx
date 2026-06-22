import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { I18nProvider } from '../../i18n/I18nProvider';
import { useI18n } from '../../i18n/useI18n';
import { GitLoadError } from './SourceControlPanel.parts';

/**
 * The Source Control panel rendered a perpetual "Loading…" spinner when the first
 * git probe threw (e.g. no workspace open, so git:status rejects). GitLoadError is
 * the failure-state that replaces it: the reason + a Retry. (The end-to-end wiring
 * — error && status===null ⇒ this branch — is covered by the screenshot harness.)
 */

afterEach(cleanup);

function Harness({ message, onRetry, busy }: { message: string; onRetry: () => void; busy: boolean }) {
  const { t } = useI18n();
  return <GitLoadError message={message} onRetry={onRetry} busy={busy} t={t} />;
}

describe('GitLoadError', () => {
  it('shows the localized title, the underlying reason, and a working Retry', () => {
    const onRetry = vi.fn();
    render(
      <I18nProvider>
        <Harness message="git:status: no workspace is open" onRetry={onRetry} busy={false} />
      </I18nProvider>,
    );

    expect(screen.getByText("Couldn't load source control")).toBeInTheDocument();
    expect(screen.getByText('git:status: no workspace is open')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables Retry while a refresh is already in flight', () => {
    render(
      <I18nProvider>
        <Harness message="boom" onRetry={() => {}} busy />
      </I18nProvider>,
    );
    // While busy the button also carries the Spinner's "Working" label → match loosely.
    expect(screen.getByRole('button', { name: /Retry/ })).toBeDisabled();
  });
});
