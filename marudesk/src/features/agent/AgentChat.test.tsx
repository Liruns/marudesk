import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '../../i18n/I18nProvider';
import { emptyAgentChatState, type AgentChatState } from '../../../shared/agent';
import { ZERO_NAV, type TabState } from '../../../shared/browser';
import { AgentChat } from './AgentChat';
import { SessionRail } from './SessionRail';
import {
  AgentScopeProvider,
  getAgentStoreForWorkspace,
  openAgentTab,
  useAgentStore,
} from './store';
import { useProvidersStore } from '../providers/store';
import { useTabsStore } from '../tabs/store';

/**
 * Behavioral regression net for AgentChat — exercises the composer handlers
 * (draft tracking, the slash menu, and send) through the real DOM + stores so a
 * refactor that moves the handlers (e.g. into a useComposer hook) is verified to
 * preserve behavior, not just types.
 */

type Listener = (payload: unknown) => void;
type MarudeskMock = {
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emit: (channel: string, payload: unknown) => void;
};

function mockMarudesk(): MarudeskMock {
  const listeners = new Map<string, Listener[]>();
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'agent:snapshot') return emptyAgentChatState();
    if (channel === 'agent:list-sessions') return [];
    if (channel === 'plugins:commands') return [];
    if (channel === 'agent:send') return { ok: true };
    return undefined;
  });
  const on = vi.fn((channel: string, handler: Listener) => {
    const next = [...(listeners.get(channel) ?? []), handler];
    listeners.set(channel, next);
    return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== handler));
  });
  const emit = (channel: string, payload: unknown) => {
    for (const handler of listeners.get(channel) ?? []) handler(payload);
  };
  (globalThis as unknown as { window: { marudesk: MarudeskMock } }).window.marudesk = {
    invoke,
    on,
    emit,
  };
  return { invoke, on, emit };
}

let marudesk: MarudeskMock;

beforeEach(() => {
  marudesk = mockMarudesk();
  useAgentStore.setState({ draft: '', chat: emptyAgentChatState(), queuedPrompts: [] });
  getAgentStoreForWorkspace('alpha').setState({ draft: '', chat: emptyAgentChatState(), queuedPrompts: [] });
  getAgentStoreForWorkspace('beta').setState({ draft: '', chat: emptyAgentChatState(), queuedPrompts: [] });
  useTabsStore.setState({ tabs: [], activeTabId: null, activeTabIdsByWorkspace: {} });
  // Skip the provider-status refresh effect so the test doesn't need those IPCs,
  // and pretend the selected provider has a key so `send` reaches the IPC.
  useProvidersStore.setState({ statusChecked: true, hasKeyForSelected: () => true });
});

afterEach(() => cleanup());

function renderChat() {
  return render(createElement(I18nProvider, null, createElement(AgentChat)));
}

function chatStateWithText(text: string): AgentChatState {
  return {
    ...emptyAgentChatState(),
    status: 'completed',
    activeSessionId: 'session-alpha',
    messages: [
      {
        id: 'm-alpha',
        role: 'assistant',
        parts: [{ type: 'text', text }],
        timestamp: 1,
      },
    ],
  };
}

function tab(id: string, kind: TabState['kind'], workspaceId: string): TabState {
  return {
    ...ZERO_NAV,
    id,
    kind,
    workspaceId,
  };
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

  it('keeps simultaneous workspace chat projections independent', async () => {
    render(
      createElement(
        I18nProvider,
        null,
        createElement(
          'div',
          null,
          createElement(
            'section',
            { 'aria-label': 'alpha chat' },
            createElement(
              AgentScopeProvider,
              { workspaceId: 'alpha' },
              createElement(AgentChat),
            ),
          ),
          createElement(
            'section',
            { 'aria-label': 'beta chat' },
            createElement(
              AgentScopeProvider,
              { workspaceId: 'beta' },
              createElement(AgentChat),
            ),
          ),
        ),
      ),
    );

    await waitFor(() => {
      expect(marudesk.invoke).toHaveBeenCalledWith('agent:snapshot', { workspaceId: 'alpha' });
      expect(marudesk.invoke).toHaveBeenCalledWith('agent:snapshot', { workspaceId: 'beta' });
      expect(marudesk.on).toHaveBeenCalledWith('agent:workspace-event', expect.any(Function));
    });

    marudesk.emit('agent:workspace-event', {
      workspaceId: 'alpha',
      state: chatStateWithText('alpha-only answer'),
    });

    const alpha = screen.getByLabelText('alpha chat');
    const beta = screen.getByLabelText('beta chat');
    await waitFor(() => expect(within(alpha).getByText('alpha-only answer')).toBeInTheDocument());
    expect(within(beta).queryByText('alpha-only answer')).not.toBeInTheDocument();
  });

  it('opens a new AI Chat tab for the active workspace instead of focusing another workspace', async () => {
    useTabsStore.setState({
      tabs: [tab('alpha-agent', 'agent', 'alpha'), tab('beta-home', 'home', 'beta')],
      activeTabId: 'beta-home',
      activeTabIdsByWorkspace: { alpha: 'alpha-agent', beta: 'beta-home' },
    });

    await openAgentTab();

    expect(marudesk.invoke).toHaveBeenCalledWith('browser:tabs-new', {
      kind: 'agent',
      workspaceId: 'beta',
    });
    expect(marudesk.invoke).not.toHaveBeenCalledWith('browser:tabs-activate', 'alpha-agent');
  });
});

describe('SessionRail', () => {
  it('animates history collapse by keeping the same rail element', () => {
    const { container } = render(
      createElement(I18nProvider, null, createElement(SessionRail)),
    );
    const rail = container.querySelector('aside');
    expect(rail).toBeInTheDocument();
    expect(rail).toHaveClass('transition-[width]');

    fireEvent.click(screen.getByLabelText(/hide session history/i));

    const collapsedRail = container.querySelector('aside');
    expect(collapsedRail).toBe(rail);
    expect(collapsedRail).toHaveClass('w-8');
    expect(collapsedRail).toHaveClass('transition-[width]');

    fireEvent.click(screen.getByLabelText(/show session history/i));

    const expandedRail = container.querySelector('aside');
    expect(expandedRail).toBe(rail);
    expect(expandedRail).toHaveClass('w-56');
  });
});
