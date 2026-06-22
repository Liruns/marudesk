import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { I18nProvider } from '../../i18n/I18nProvider';
import { useProvidersStore } from '../providers/store';
import { ProvidersSettings } from './ProvidersSettings';

// Isolate the panel's own banner logic from the provider cards / custom-endpoint
// section (which have their own IPC-bound effects).
vi.mock('./ProviderCard', () => ({ ProviderCard: () => null }));
vi.mock('./CustomEndpointsSection', () => ({ CustomEndpointsSection: () => null }));

afterEach(cleanup);

/**
 * refreshProviderStatus() records statusError when the secrets/keychain read
 * rejects, but no component rendered it — so a failed CHECK looked identical to
 * "no keys configured", and the user might re-enter a key they already saved.
 * The panel now shows an alert banner + Retry.
 */
describe('ProvidersSettings — a failed provider-status check is visible', () => {
  it('renders an alert with a Retry that re-runs the check', () => {
    const refreshSpy = vi.fn(async () => {});
    useProvidersStore.setState({
      statusChecked: true, // skip the auto-refresh effect
      statusError: 'keychain is locked',
      providerStatus: [],
      refreshProviderStatus: refreshSpy,
    });

    render(
      <I18nProvider>
        <ProvidersSettings />
      </I18nProvider>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't check which providers have keys/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('shows no alert when the check succeeded (statusError null)', () => {
    useProvidersStore.setState({
      statusChecked: true,
      statusError: null,
      providerStatus: [],
      refreshProviderStatus: vi.fn(async () => {}),
    });

    render(
      <I18nProvider>
        <ProvidersSettings />
      </I18nProvider>,
    );

    expect(screen.queryByRole('alert')).toBeNull();
  });
});
