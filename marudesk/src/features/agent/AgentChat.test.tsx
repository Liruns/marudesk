import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
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
import { useWorkspaceStore } from '../workspace/store';

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
  // and pretend every provider has a key so `send` reaches the IPC — dispatch
  // checks the ACTIVE THREAD's provider against providerStatus directly.
  useProvidersStore.setState((s) => ({
    statusChecked: true,
    providerStatus: s.providerStatus.map((p) => ({ ...p, hasKey: true })),
  }));
});

afterEach(() => {
  cleanup();
  useWorkspaceStore.setState({ summary: null });
});

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

  it('keeps an in-progress draft when a turn completes (no external-update clobber)', async () => {
    renderChat();
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'my next message' } });
    expect(useAgentStore.getState().draft).toBe('my next message');

    // A finished turn pushes a completed snapshot; ingest() then async-reloads
    // sessions. Neither should wipe the draft the user is mid-typing.
    marudesk.emit('agent:event', chatStateWithText('the answer'));
    await waitFor(() =>
      expect(marudesk.invoke).toHaveBeenCalledWith('agent:list-sessions', expect.anything()),
    );

    expect(useAgentStore.getState().draft).toBe('my next message');
    expect(ta.value).toBe('my next message');
  });

  it('lets the user keep typing after a turn completes', async () => {
    renderChat();
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;

    marudesk.emit('agent:event', chatStateWithText('the answer'));
    await waitFor(() =>
      expect(marudesk.invoke).toHaveBeenCalledWith('agent:list-sessions', expect.anything()),
    );

    // Typing after the turn must still land in the draft.
    fireEvent.change(ta, { target: { value: 'follow-up question' } });
    expect(useAgentStore.getState().draft).toBe('follow-up question');
    expect(ta.value).toBe('follow-up question');
  });

  it('does not wipe a mid-composition Hangul syllable on a stray re-render (IME-safe)', async () => {
    renderChat();
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;

    // A turn finishes — completion snapshot + the async session reload re-render
    // the panel right as the user starts composing their next message.
    marudesk.emit('agent:event', chatStateWithText('the answer'));
    await waitFor(() =>
      expect(marudesk.invoke).toHaveBeenCalledWith('agent:list-sessions', expect.anything()),
    );

    // The IME writes the composing syllable straight to the DOM; onChange/draft
    // lags until compositionend. A controlled `value={draft}` would let React's
    // value writeback reset node.value to '' here — wiping the syllable. The
    // uncontrolled composer must leave the composing buffer alone.
    fireEvent.compositionStart(ta);
    ta.value = '한';
    // Flush the stray re-render synchronously (act) so React's commit — and, in
    // the controlled version, its value writeback — actually runs before we
    // assert. Without act the re-render is deferred and the clobber is masked.
    act(() => {
      marudesk.emit('agent:event', chatStateWithText('the answer'));
    });
    expect(ta.value).toBe('한');

    // Finishing the composition commits the settled text to the store.
    fireEvent.compositionEnd(ta, { target: { value: '한글' } });
    expect(useAgentStore.getState().draft).toBe('한글');
    expect(ta.value).toBe('한글');
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

describe('AgentChat empty state', () => {
  it('global chat keeps the default title + browser-debug suggestions (no override)', () => {
    // The default browser-debug suggestions are gated on an open workspace.
    useWorkspaceStore.setState({
      summary: { root: '/ws', name: 'ws', files: [], source: 'walk', truncated: false },
    });
    renderChat();
    expect(screen.getByText('Agentic AI Chat')).toBeInTheDocument();
    // Default browser-debug first move stays for the global bot.
    expect(screen.getByText('Fix the console error on this page')).toBeInTheDocument();
    // No task-aware subtitle leaks into the global path.
    expect(screen.queryByText(/^Briefed on:/)).not.toBeInTheDocument();
  });

  it('task-aware override shows "Briefed on" + task suggestions and a click fills the draft', () => {
    render(
      <I18nProvider>
        <AgentChat
          emptyState={{
            subtitle: 'Briefed on: Ship the login fix',
            suggestions: ['Implement this task', 'Explain the acceptance criteria'],
          }}
        />
      </I18nProvider>,
    );

    expect(screen.getByText('Briefed on: Ship the login fix')).toBeInTheDocument();
    // The task suggestions replace the browser-debug ones.
    expect(screen.getByText('Implement this task')).toBeInTheDocument();
    expect(screen.queryByText('Fix the console error on this page')).not.toBeInTheDocument();

    // Clicking a suggestion fills the composer the same way the default ones do.
    fireEvent.click(screen.getByText('Implement this task'));
    expect(useAgentStore.getState().draft).toBe('Implement this task');
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
    // Expanded width is container-gated: full 224px only in a wide pane.
    expect(expandedRail).toHaveClass('@[56rem]:w-56');
  });
});
