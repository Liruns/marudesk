import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { I18nProvider } from '../../i18n/I18nProvider';
import { emptyAgentChatState } from '../../../shared/agent';
import { AgentChat } from './AgentChat';
import { useAgentStore } from './store';
import { useProvidersStore } from '../providers/store';

/**
 * Behavioral regression net for AgentChat — exercises the composer handlers
 * (draft tracking, the slash menu, and send) through the real DOM + stores so a
 * refactor that moves the handlers (e.g. into a useComposer hook) is verified to
 * preserve behavior, not just types.
 */

type MarudeskMock = { invoke: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };

function mockMarudesk(): MarudeskMock {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'agent:snapshot') return emptyAgentChatState();
    if (channel === 'plugins:commands') return [];
    if (channel === 'agent:send') return { ok: true };
    return undefined;
  });
  const on = vi.fn(() => () => {});
  (globalThis as unknown as { window: { marudesk: MarudeskMock } }).window.marudesk = {
    invoke,
    on,
  };
  return { invoke, on };
}

let marudesk: MarudeskMock;

beforeEach(() => {
  marudesk = mockMarudesk();
  useAgentStore.setState({ draft: '', chat: emptyAgentChatState(), queuedPrompt: null });
  // Skip the provider-status refresh effect so the test doesn't need those IPCs,
  // and pretend the selected provider has a key so `send` reaches the IPC.
  useProvidersStore.setState({ statusChecked: true, hasKeyForSelected: () => true });
});

afterEach(() => cleanup());

function renderChat() {
  return render(createElement(I18nProvider, null, createElement(AgentChat)));
}

describe('AgentChat composer', () => {
  it('renders the prompt textarea', () => {
    renderChat();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('typing updates the draft in the store', () => {
    renderChat();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello world' } });
    expect(useAgentStore.getState().draft).toBe('hello world');
  });

  it('typing "/" opens the slash-command menu', async () => {
    renderChat();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/' } });
    // The slash menu lists the built-in `/compact` command among others.
    await waitFor(() => expect(screen.getByText(/compact/i)).toBeInTheDocument());
  });

  it('Enter on a non-empty draft sends the prompt', async () => {
    renderChat();
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'do the thing' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() =>
      expect(marudesk.invoke).toHaveBeenCalledWith('agent:send', expect.anything()),
    );
  });
});
