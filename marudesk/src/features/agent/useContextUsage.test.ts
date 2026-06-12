import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { emptyAgentChatState } from '../../../shared/agent';
import type { ModelEntry } from '../../../shared/providers';
import { useAgentStore } from './store';
import { useProvidersStore } from '../providers/store';
import { useContextUsage } from './useContextUsage';

/**
 * Unit net for the shared context-occupancy math behind the StatusBar ring and
 * the composer's almost-full nudge. Drives the real agent + providers stores so
 * a refactor that changes how `contextTokens` maps to a percentage is caught.
 */

const MODEL: ModelEntry = {
  key: 'anthropic:test',
  id: 'test',
  label: 'Test',
  provider: 'anthropic',
  contextWindow: 200_000,
};

function setUsage(contextTokens: number, inputTokens = contextTokens, outputTokens = 0): void {
  useAgentStore.setState({
    chat: { ...emptyAgentChatState(), usage: { inputTokens, outputTokens, contextTokens } },
  });
}

beforeEach(() => {
  // The hook only reads store state, but the store modules expect a window.marudesk
  // bridge to exist; a no-op stub keeps imports happy under jsdom.
  (globalThis as unknown as { window: { marudesk: unknown } }).window.marudesk = {
    invoke: async () => undefined,
    on: () => () => {},
  };
  // Empty thread pins → the effective model is the global selection.
  useAgentStore.setState({ chat: emptyAgentChatState(), modelKeyByThread: {} });
  useProvidersStore.setState({ models: [MODEL], selectedModelKey: MODEL.key });
});

afterEach(() => cleanup());

describe('useContextUsage', () => {
  it('returns null until a turn consumes tokens', () => {
    const { result } = renderHook(() => useContextUsage());
    expect(result.current).toBeNull();
  });

  it('computes occupancy from contextTokens against the model window', () => {
    setUsage(100_000);
    const { result } = renderHook(() => useContextUsage());
    expect(result.current?.pct).toBe(50);
    expect(result.current?.contextTokens).toBe(100_000);
    expect(result.current?.model?.key).toBe(MODEL.key);
  });

  it('caps occupancy at 100% when context overflows the window', () => {
    setUsage(250_000);
    const { result } = renderHook(() => useContextUsage());
    expect(result.current?.pct).toBe(100);
  });

  it('reports a null pct when the model has no known context window', () => {
    useProvidersStore.setState({
      models: [{ ...MODEL, contextWindow: undefined }],
      selectedModelKey: MODEL.key,
    });
    setUsage(100_000);
    const { result } = renderHook(() => useContextUsage());
    expect(result.current).not.toBeNull();
    expect(result.current?.pct).toBeNull();
  });
});
