import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { PluginStatus } from '../../../shared/plugin';
import { PluginCard } from './PluginCard';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function makeStatus(extra?: Partial<PluginStatus>): PluginStatus {
  return {
    id: 'p1',
    name: 'Demo',
    version: '1.0.0',
    scope: 'user',
    state: 'disabled',
    permissions: ['cmd', 'fs:read'],
    granted: [],
    toolNames: [],
    commandNames: [],
    ...extra,
  };
}

function renderCard(
  onToggle: (id: string, enabled: boolean) => Promise<void>,
  status = makeStatus(),
): void {
  render(
    <I18nProvider>
      <PluginCard status={status} busy={false} onToggle={onToggle} onRemove={async () => {}} />
    </I18nProvider>,
  );
}

/**
 * Enabling a plugin grants ALL its declared permissions at once (incl. cmd =
 * shell exec). A single Switch flip must not be a silent high-impact grant.
 */
describe('PluginCard — enabling requires permission consent', () => {
  it('confirms (listing the permissions) before enabling, and does NOT enable if declined', () => {
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    const onToggle = vi.fn(async () => {});
    renderCard(onToggle);

    fireEvent.click(screen.getByRole('switch'));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('cmd')); // the grant is spelled out
    expect(onToggle).not.toHaveBeenCalled(); // declined → not enabled
  });

  it('enables when the user accepts the grant', () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const onToggle = vi.fn(async () => {});
    renderCard(onToggle);

    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith('p1', true);
  });

  it('does not prompt when DISABLING an active plugin', () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);
    const onToggle = vi.fn(async () => {});
    renderCard(onToggle, makeStatus({ state: 'active' }));

    fireEvent.click(screen.getByRole('switch'));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onToggle).toHaveBeenCalledWith('p1', false);
  });
});
