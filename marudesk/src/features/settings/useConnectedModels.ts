import { useEffect } from 'react';
import type { ModelEntry } from '../../../shared/providers';
import { useProvidersStore } from '../providers/store';

/**
 * Shared source for the agent model pickers (fallback chain + delegate model, v6):
 * the full model list, the connected tool-capable subset, and an `isConnected`
 * predicate — plus a one-time provider-status refresh so the connected set is
 * accurate on first render. Keeps the connection heuristic and tool filter in one
 * place instead of re-derived per picker.
 */
export function useConnectedToolModels(): {
  /** Every known model (for label lookups, incl. now-disconnected refs). */
  models: ModelEntry[];
  /** Connected, tool-capable models — the pickable candidates. */
  toolModels: ModelEntry[];
  isConnected: (provider: string) => boolean;
} {
  const models = useProvidersStore((s) => s.models);
  const providerStatus = useProvidersStore((s) => s.providerStatus);
  const statusChecked = useProvidersStore((s) => s.statusChecked);
  const refreshProviderStatus = useProvidersStore((s) => s.refreshProviderStatus);

  useEffect(() => {
    if (!statusChecked) void refreshProviderStatus();
  }, [statusChecked, refreshProviderStatus]);

  const isConnected = (provider: string): boolean => {
    if (provider.startsWith('custom:')) return true;
    const status = providerStatus.find((candidate) => candidate.id === provider);
    return !!status?.hasKey || !!status?.oauth;
  };
  const toolModels = models.filter((model) => model.tools !== false && isConnected(model.provider));
  return { models, toolModels, isConnected };
}
