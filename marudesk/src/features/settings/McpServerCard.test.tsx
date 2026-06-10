import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { McpServerStatus } from '../../../shared/mcp';
import { I18nProvider } from '../../i18n/I18nProvider';
import { McpServerCard } from './McpServerCard';

afterEach(() => cleanup());

function status(patch: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    id: 'srv',
    transport: 'stdio',
    target: 'cmd',
    enabled: true,
    trusted: false,
    disabledTools: [],
    autoApproveTools: [],
    confirmTools: [],
    state: 'connected',
    toolCount: 1,
    tools: ['visible_tool'],
    ...patch,
  };
}

function renderCard(
  server: McpServerStatus,
  overrides: Partial<{
    readonly onToggle: (id: string, enabled: boolean) => Promise<void>;
    readonly onUpdate: (
      id: string,
      patch: {
        readonly trust?: boolean;
        readonly disabledTools?: string[];
        readonly autoApproveTools?: string[];
        readonly confirmTools?: string[];
      },
    ) => Promise<void>;
    readonly onRemove: (id: string) => Promise<void>;
  }> = {},
) {
  const onToggle = overrides.onToggle ?? vi.fn(async () => {});
  const onUpdate = overrides.onUpdate ?? vi.fn(async () => {});
  const onRemove = overrides.onRemove ?? vi.fn(async () => {});
  render(createElement(
    I18nProvider,
    null,
    createElement(McpServerCard, {
      status: server,
      busy: false,
      onToggle,
      onUpdate,
      onRemove,
    }),
  ));
  return { onToggle, onUpdate, onRemove };
}

describe('McpServerCard tool policy controls', () => {
  it('keeps saved hidden tools visible and persists policy edits', async () => {
    const onUpdate = vi.fn(async () => {});
    renderCard(status({
      disabledTools: ['hidden_tool'],
      tools: ['visible_tool'],
    }), { onUpdate });

    expect(screen.getAllByText('hidden_tool').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Manual tool names not reported/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Auto-approved tools: hidden_tool' }));

    const save = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);

    expect(onUpdate).toHaveBeenCalledWith('srv', {
      trust: false,
      disabledTools: [],
      autoApproveTools: ['hidden_tool'],
      confirmTools: [],
    });
  });

  it('warns when manual policy lists conflict', () => {
    renderCard(status({
      disabledTools: ['visible_tool'],
      autoApproveTools: ['visible_tool'],
      tools: ['visible_tool'],
    }));

    expect(screen.getByText(/Conflicting tool policies/i)).toHaveTextContent('visible_tool');
  });
});
