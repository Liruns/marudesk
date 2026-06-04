import type {
  AgentChatState,
  AgentMessage,
  AgentPart,
  ToolCall,
} from '../types';
import { emptyAgentChatState } from '../types';
import { Emitter } from './emitter';
import type {
  Transport,
  TransportCommand,
  TransportCommandArgs,
  TransportStatusInfo,
  Unsubscribe,
} from './types';

/**
 * In-memory fake transport — the DEFAULT in dev. No relay, no PC, no network.
 *
 * It fabricates a believable agent turn so the WHOLE UI (streaming bubbles, a
 * reasoning block, a tool-call card, an approval prompt, and an ask_user
 * question) is exercisable/demoable standalone. Every UI command is wired:
 *   - `send`     → scripts a turn: thinking → streamed reply → tool card → approval
 *   - `approve`  → resolves the pending approval (runs or denies the tool), then
 *                  continues to an ask_user question and finally completes
 *   - `respond`  → answers the ask_user question and completes the turn
 *   - `abort`    → stops the scripted turn, marks running tools aborted
 *   - `reset`    → clears the conversation back to empty/idle
 *   - `snapshot` → re-emits current state
 *
 * Timers are tracked and cleared on `disconnect()`/`abort` so nothing leaks.
 */
export class StubTransport implements Transport {
  private state: AgentChatState = emptyAgentChatState();
  private readonly stateEmitter = new Emitter<AgentChatState>();
  private readonly statusEmitter = new Emitter<TransportStatusInfo>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private connected = false;
  private turnCounter = 0;

  connect(_relayUrl: string, _accessToken: string): Promise<void> {
    this.connected = true;
    this.setStatus({ status: 'connecting', hostOnline: false });
    // Simulate a brief handshake, then "PC host online".
    this.schedule(() => {
      this.setStatus({ status: 'connected', hostOnline: true });
      this.emitState();
    }, 350);
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
    this.clearTimers();
    this.setStatus({ status: 'disconnected', hostOnline: false });
  }

  onState(cb: (state: AgentChatState) => void): Unsubscribe {
    return this.stateEmitter.subscribe(cb);
  }

  onStatus(cb: (info: TransportStatusInfo) => void): Unsubscribe {
    return this.statusEmitter.subscribe(cb);
  }

  send<K extends TransportCommand>(cmd: K, args: TransportCommandArgs[K]): Promise<void> {
    if (!this.connected) return Promise.reject(new Error('not connected'));
    switch (cmd) {
      case 'send':
        this.scriptTurn((args as TransportCommandArgs['send']).prompt);
        break;
      case 'approve':
        this.resolveApproval((args as TransportCommandArgs['approve']).approved);
        break;
      case 'respond':
        this.resolveQuestions((args as TransportCommandArgs['respond']).answers);
        break;
      case 'abort':
        this.abortTurn();
        break;
      case 'reset':
        this.clearTimers();
        this.state = emptyAgentChatState();
        this.emitState();
        break;
      case 'snapshot':
        this.emitState();
        break;
    }
    return Promise.resolve();
  }

  /* ── scripted turn ─────────────────────────────────────────────────────── */

  private scriptTurn(prompt: string): void {
    this.clearTimers();
    const turnId = `stub-turn-${++this.turnCounter}`;
    const userMsg: AgentMessage = {
      id: `${turnId}-user`,
      role: 'user',
      parts: [{ type: 'text', text: prompt }],
      timestamp: Date.now(),
    };
    const assistantId = `${turnId}-assistant`;

    this.patch({
      turnId,
      status: 'thinking',
      error: null,
      pendingApproval: null,
      pendingQuestions: null,
      messages: [...this.state.messages, userMsg],
    });

    // 1) Reasoning + start streaming text.
    this.schedule(() => {
      this.upsertAssistant(assistantId, turnId, [
        { type: 'reasoning', text: 'Looking at the running app via the PC bridge…' },
        { type: 'text', text: 'On it — ' },
      ]);
    }, 500);

    // 2) Stream the rest of the reply token-ish by token.
    const chunks = ['inspecting ', 'the current page ', 'and console first.'];
    chunks.forEach((chunk, i) => {
      this.schedule(() => {
        const msg = this.findAssistant(assistantId);
        const prev = msg ? lastText(msg) : '';
        this.upsertAssistant(assistantId, turnId, [
          { type: 'reasoning', text: 'Looking at the running app via the PC bridge…' },
          { type: 'text', text: prev + chunk },
        ]);
      }, 800 + i * 280);
    });

    // 3) Add a running tool-call card.
    this.schedule(() => {
      const tool: ToolCall = {
        id: `${turnId}-tool-1`,
        name: 'read_console',
        input: { level: 'error', limit: 50 },
        state: 'running',
        summary: 'read_console(level=error)',
      };
      this.patch({ status: 'working' });
      this.appendToolToAssistant(assistantId, turnId, tool);
    }, 1750);

    // 4) Tool finishes ok.
    this.schedule(() => {
      this.updateTool(assistantId, `${turnId}-tool-1`, {
        state: 'ok',
        resultText:
          '2 console errors:\n' +
          "  Uncaught TypeError: Cannot read properties of undefined (reading 'id')\n" +
          '    at CartView.tsx:42\n' +
          '  Failed to load resource: 500 (/api/cart)',
      });
    }, 2600);

    // 5) Park on an approval for a gated tool (eval_js).
    this.schedule(() => {
      const gated: ToolCall = {
        id: `${turnId}-tool-2`,
        name: 'eval_js',
        input: { expression: 'window.__APP_STATE__?.cart' },
        state: 'awaiting_approval',
        summary: 'eval_js — read window.__APP_STATE__.cart',
      };
      this.appendToolToAssistant(assistantId, turnId, gated);
      this.patch({
        status: 'waiting_for_user',
        pendingApproval: {
          turnId,
          callId: gated.id,
          name: 'eval_js',
          detail: 'window.__APP_STATE__?.cart',
        },
      });
    }, 3100);
  }

  private resolveApproval(approved: boolean): void {
    const pending = this.state.pendingApproval;
    if (!pending) return;
    const assistantId = `${pending.turnId}-assistant`;
    this.updateTool(assistantId, pending.callId, {
      state: approved ? 'running' : 'denied',
    });
    this.patch({ pendingApproval: null, status: approved ? 'working' : 'thinking' });

    if (!approved) {
      // Denied → wrap the turn up with a short note.
      this.schedule(() => {
        const msg = this.findAssistant(assistantId);
        const prev = msg ? lastText(msg) : '';
        this.upsertAssistantKeepTools(assistantId, pending.turnId, prev + '\n\nOK, skipping that. ');
        this.patch({ status: 'completed', turnId: null });
      }, 500);
      return;
    }

    // Approved → tool runs ok, then the agent asks a clarifying question.
    this.schedule(() => {
      this.updateTool(assistantId, pending.callId, {
        state: 'ok',
        resultText: '{ items: 3, subtotalCents: 4197, currency: "USD" }',
      });
    }, 700);

    this.schedule(() => {
      this.patch({
        status: 'waiting_for_user',
        pendingQuestions: {
          turnId: pending.turnId,
          callId: `${pending.turnId}-q1`,
          questions: [
            {
              id: 'fix-approach',
              question:
                'The crash is a null cart item at CartView.tsx:42. How should I fix it?',
              options: ['Guard with optional chaining', 'Fix the /api/cart 500 first'],
            },
          ],
        },
      });
    }, 1300);
  }

  private resolveQuestions(answers: Record<string, string>): void {
    const pending = this.state.pendingQuestions;
    if (!pending) return;
    const assistantId = `${pending.turnId}-assistant`;
    const answer = Object.values(answers)[0] ?? 'Proceed';
    this.patch({ pendingQuestions: null, status: 'working' });
    this.schedule(() => {
      const msg = this.findAssistant(assistantId);
      const prev = msg ? lastText(msg) : '';
      this.upsertAssistantKeepTools(
        assistantId,
        pending.turnId,
        prev + `\n\nGot it — "${answer}". I'll add the optional-chaining guard and re-check the console.`,
      );
      this.patch({
        status: 'completed',
        turnId: null,
        usage: { inputTokens: 1280, outputTokens: 342, contextTokens: 1280 },
      });
    }, 900);
  }

  private abortTurn(): void {
    this.clearTimers();
    const next = { ...this.state };
    next.messages = next.messages.map((m) => ({
      ...m,
      parts: m.parts.map((p) =>
        p.type === 'tool' && (p.call.state === 'running' || p.call.state === 'awaiting_approval')
          ? { type: 'tool', call: { ...p.call, state: 'aborted' as const } }
          : p,
      ),
    }));
    next.status = 'idle';
    next.turnId = null;
    next.pendingApproval = null;
    next.pendingQuestions = null;
    this.state = next;
    this.emitState();
  }

  /* ── state helpers ─────────────────────────────────────────────────────── */

  private patch(partial: Partial<AgentChatState>): void {
    this.state = { ...this.state, ...partial };
    this.emitState();
  }

  private findAssistant(id: string): AgentMessage | undefined {
    return this.state.messages.find((m) => m.id === id);
  }

  /** Create or replace the assistant message's parts (text/reasoning only). */
  private upsertAssistant(id: string, _turnId: string, parts: AgentPart[]): void {
    this.replaceAssistant(id, parts);
  }

  /** Replace text/reasoning parts but KEEP any existing tool parts (append order). */
  private upsertAssistantKeepTools(id: string, turnId: string, text: string): void {
    const existing = this.findAssistant(id);
    const tools = existing ? existing.parts.filter((p): p is Extract<AgentPart, { type: 'tool' }> => p.type === 'tool') : [];
    const reasoning = existing?.parts.find((p) => p.type === 'reasoning');
    const parts: AgentPart[] = [];
    if (reasoning) parts.push(reasoning);
    parts.push({ type: 'text', text });
    parts.push(...tools);
    this.replaceAssistant(id, parts, turnId);
  }

  private appendToolToAssistant(id: string, turnId: string, tool: ToolCall): void {
    const existing = this.findAssistant(id);
    const parts = existing ? [...existing.parts] : [];
    parts.push({ type: 'tool', call: tool });
    this.replaceAssistant(id, parts, turnId);
  }

  private updateTool(assistantId: string, callId: string, patch: Partial<ToolCall>): void {
    const msg = this.findAssistant(assistantId);
    if (!msg) return;
    const parts = msg.parts.map((p) =>
      p.type === 'tool' && p.call.id === callId
        ? { type: 'tool' as const, call: { ...p.call, ...patch } }
        : p,
    );
    this.replaceAssistant(assistantId, parts);
  }

  private replaceAssistant(id: string, parts: AgentPart[], turnId?: string): void {
    const exists = this.state.messages.some((m) => m.id === id);
    const messages = exists
      ? this.state.messages.map((m) => (m.id === id ? { ...m, parts } : m))
      : [
          ...this.state.messages,
          { id, role: 'assistant' as const, parts, timestamp: Date.now() },
        ];
    this.state = { ...this.state, messages };
    if (turnId) this.state.turnId = turnId;
    this.emitState();
  }

  private emitState(): void {
    // Emit a shallow clone so React sees a new reference each tick.
    this.stateEmitter.emit({ ...this.state, messages: [...this.state.messages] });
  }

  private setStatus(info: TransportStatusInfo): void {
    this.statusEmitter.emit(info);
  }

  private schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.connected) fn();
    }, ms);
    this.timers.add(t);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

/** Last text-part content of a message (for incremental streaming). */
function lastText(msg: AgentMessage): string {
  const textParts = msg.parts.filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text');
  return textParts.length ? textParts[textParts.length - 1]!.text : '';
}
