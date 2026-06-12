import { findModel, type ModelEntry } from '../../../shared/providers';
import { useProvidersStore } from '../providers/store';
import { useAgentStore, useThreadModelKey } from './store';

export type ContextUsage = {
  /** Context-window occupancy 0-100, or null when the model's window is unknown. */
  pct: number | null;
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  model: ModelEntry | undefined;
};

/**
 * The active conversation's live context occupancy, shared by the StatusBar
 * {@link ContextRing} and the composer's almost-full nudge so both agree on the
 * same math. Returns null until a turn has actually consumed tokens.
 *
 * Tracks `contextTokens` (the last model call's input size), not the cumulative
 * input total — so the figure falls after a compaction instead of climbing.
 */
export function useContextUsage(): ContextUsage | null {
  const usage = useAgentStore((s) => s.chat.usage);
  const modelKey = useThreadModelKey();
  const models = useProvidersStore((s) => s.models);

  if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.contextTokens === 0) {
    return null;
  }

  const model = findModel(models, modelKey);
  const ctx = model?.contextWindow;
  const pct = ctx ? Math.min(100, Math.round((usage.contextTokens / ctx) * 100)) : null;

  return {
    pct,
    contextTokens: usage.contextTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    model,
  };
}
