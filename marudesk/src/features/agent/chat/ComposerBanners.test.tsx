import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { I18nProvider } from '../../../i18n/I18nProvider';
import { emptyAgentChatState } from '../../../../shared/agent';
import type { ModelEntry } from '../../../../shared/providers';
import { useAgentStore } from '../store';
import { useProvidersStore } from '../../providers/store';
import { useSettingsStore } from '../../settings/store';
import { ComposerBanners } from './ComposerBanners';

/**
 * Behavioral net for the almost-full compaction nudge: it should appear only at
 * high context occupancy AND only in manual mode (auto-compact off), since the
 * auto path already compacts past its own threshold once a turn settles.
 */

const WINDOW = 200_000;
const MODEL: ModelEntry = {
  key: 'anthropic:test',
  id: 'test',
  label: 'Test',
  provider: 'anthropic',
  contextWindow: WINDOW,
};

/** Drive the active conversation to a given context-window occupancy (0-100). */
function setOccupancy(pct: number): void {
  const contextTokens = Math.round((pct / 100) * WINDOW);
  useAgentStore.setState({
    chat: { ...emptyAgentChatState(), usage: { inputTokens: contextTokens, outputTokens: 0, contextTokens } },
  });
}

function setAutoCompact(enabled: boolean): void {
  useSettingsStore.setState((s) => ({
    settings: {
      ...s.settings,
      agent: { ...s.settings.agent, autoCompact: { ...s.settings.agent.autoCompact, enabled } },
    },
  }));
}

function renderBanners() {
  return render(createElement(I18nProvider, null, createElement(ComposerBanners)));
}

function compactButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: 'Compact' });
}

beforeEach(() => {
  (globalThis as unknown as { window: { marudesk: unknown } }).window.marudesk = {
    invoke: async () => undefined,
    on: () => () => {},
  };
  useAgentStore.setState({ chat: emptyAgentChatState(), modelKeyByThread: {}, queuedPrompts: [], localError: null });
  useProvidersStore.setState({ models: [MODEL], selectedModelKey: MODEL.key });
});

afterEach(() => cleanup());

describe('ComposerBanners — compaction nudge', () => {
  it('shows the nudge past 90% when auto-compact is off', () => {
    setAutoCompact(false);
    setOccupancy(95);
    renderBanners();
    expect(compactButton()).not.toBeNull();
  });

  it('hides the nudge when auto-compact is on (the agent handles it)', () => {
    setAutoCompact(true);
    setOccupancy(95);
    renderBanners();
    expect(compactButton()).toBeNull();
  });

  it('hides the nudge below the occupancy threshold', () => {
    setAutoCompact(false);
    setOccupancy(50);
    renderBanners();
    expect(compactButton()).toBeNull();
  });
});
