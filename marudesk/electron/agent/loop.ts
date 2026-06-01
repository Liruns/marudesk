import fs from 'node:fs/promises';
import type {
  AgentAnswers,
  AgentChatState,
  AgentEdit,
  AgentMessage,
  AgentReasoningPart,
  AgentSendInput,
  AgentSendResult,
  AgentTextPart,
  ToolCall,
} from '../../shared/agent';
import { emptyAgentChatState } from '../../shared/agent';
import type { AppliedChange } from '../../shared/patch';
import type { WorkspaceSummary } from '../../shared/workspace';
import { scrubText } from '../../shared/scrub';
import { getProvider, isBuiltinProviderId } from '../../shared/providers';
import { coalesced } from '../coalesce';
import { getProviderApiKey } from '../secrets';
import { CLAUDE_CODE_SYSTEM_PREFIX, supportsOAuth } from '../oauth/config';
import { getValidAccessToken } from '../oauth/flow';
import { getCustomProvider } from '../custom-providers';
import { getSettingsSync } from '../settings';
import type { AgentApprovalMode } from '../../shared/settings';
import { requireWorkspace } from '../ipc/define-handler';
import { getHost, getTab, setNetworkCapture } from '../browser/state';
import { isInsideRoot, resolveWorkspacePath } from '../fs-safe';
import { writeFileForEditor } from '../workspace';
import { streamText, generateText, type ModelMessage } from 'ai';
import { buildModel, aiTools, humanizeModelError, type ModelAuth } from './model';
import { loadWorkspaceInstructions } from './instructions';
import { ASK_USER, describeToolInput, type ToolContext } from './tools';
import { callMcpTool, isGatedTool, isWriteTool, listMcpTools } from './mcp';
import { saveSession } from './sessions-store';
import type { SessionRecord } from '../../shared/context';

/**
 * The manual step-driven agent loop (docs/agentic-chat-design.md §5). main owns
 * the authoritative {@link AgentChatState}; each step is one driver round-trip,
 * after which we execute the model's tool calls (parking on approval/ask_user),
 * append results, and re-enter. A single conversation at a time keeps the model
 * vs. transcript bookkeeping trivial. State is streamed to the renderer as a
 * coalesced `agent:event` snapshot (the renderer is a pure projection).
 */

const MAX_STEPS = 24;

/** Per-step output-token cap (matches the prior hand-rolled driver). */
const AGENT_MAX_TOKENS = 4_096;

const SYSTEM_PROMPT = `You are marudesk's agentic coding assistant, running INSIDE a desktop IDE that owns the user's live browser (via the Chrome DevTools Protocol), the code editor, and the terminal for their open workspace.

Your tools let you: read/search/edit workspace files; read the live page's captured console errors, DOM, and network; evaluate JS in the page (with the user's approval); and reload the page to re-observe.

You also have a built-in context MCP — pull from the app ON DEMAND instead of assuming:
- list_tabs, then read_page (any web tab's visible text), read_editor (open buffers incl. UNSAVED edits), read_explorer (file-tree state).
- list_terminals / read_terminal (command output the user ran), read_console (all console levels) / get_console_errors (errors + source file) / read_network (DevTools).
- list_sessions / read_session (your previous conversations) and list_memory / read_memory / write_memory (durable notes that persist across sessions — remember user facts, preferences, and project context so you don't re-ask).
- open_path / open_external / reveal_in_explorer ACT on the computer (open a file/folder in its default app, open a URL in the system browser, reveal a path in the OS file manager) — available only when the user enabled "PC control" in Settings; each call asks for approval.
Fetch only what you need for the task; don't dump everything.

Operating rules:
- Investigate before editing. Read the relevant files (read_file / grep) so each edit's oldString matches verbatim and is unique.
- Make the SMALLEST change that fixes the problem. Use multi_edit when a fix spans several sites (it is atomic).
- Ground fixes in runtime evidence: for a "fix this error" task, start with get_console_errors and follow the confidence-tagged source file.
- ALWAYS verify. After editing to fix a runtime error, call reload_and_verify with the error text as errorSignature and report whether it is GONE or STILL PRESENT. Never claim success without verifying.
- Network is for TRIAGE: a failing status is often backend/infra, not a frontend bug. Inspect response bodies for malformed shapes before patching the frontend.
- Secrets in page data are redacted as «redacted». Never ask the user to paste a secret.
- If the request is ambiguous or needs a decision, call ask_user instead of guessing.
- Keep the user in control: explain what you changed and why in plain prose. They can revert any edit.

Paths are workspace-relative. To create a file, call edit_file with oldString="".`;

/* ── module state ───────────────────────────────────────────────────────── */

let state: AgentChatState = emptyAgentChatState();
// The provider-neutral running transcript (multi-turn). Kept valid at all times
// (every tool_use is answered by a tool_result) so a later turn can reuse it.
let transcript: ModelMessage[] = [];
let controller: AbortController | null = null;
let approvalResolver: ((approved: boolean) => void) | null = null;
let answersResolver: ((answers: AgentAnswers) => void) | null = null;
// Synchronous re-entrancy guard: status is only set busy *after* an await in
// startTurn, so two near-simultaneous sends could both pass busy(). This closes
// that window before the first await.
let starting = false;
// The web tab the active turn targets — so finish() can stop the lazy network
// capture it may have enabled (otherwise the relay keeps buffering forever).
let activeTabId: string | undefined;
// The current conversation's stable session id (assigned on the first turn after
// a reset) + metadata, so finish() can persist the transcript to sessions-store
// for the AI's `list_sessions` / `read_session` context tools (and a future
// sessions UI). Reused across the conversation's turns — each save updates the
// same record; reset() clears it so the next turn begins a new session.
let conversationId: string | null = null;
let conversationStartedAt = 0;
let conversationProvider = '';
let conversationModel = '';
let conversationTitle = '';
let seq = 0;

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${++seq}`;
}

function busy(): boolean {
  return state.status === 'thinking' || state.status === 'working' || state.status === 'waiting_for_user';
}

/* ── event fan-out (renderer push + in-process subscribers) ─────────────── */

// In-process subscribers to the authoritative state stream. The headless server
// (electron/server) subscribes here to relay `agent:event` over SSE — the loop's
// functions are called directly (no IPC), so this is the renderer-side push's
// peer for any non-renderer head. Kept module-level so it survives across turns.
const subscribers = new Set<(state: AgentChatState) => void>();

/**
 * Subscribe to the authoritative {@link AgentChatState} stream — every state the
 * renderer would receive on `agent:event` is also delivered here. Used by the
 * in-process bridge server (docs/remote-mobile-bridge-design §M4) so a future
 * companion app can mirror the same chat. Returns an unsubscribe fn. The callback
 * must not throw (we isolate it so one bad subscriber can't break the others or
 * the renderer push).
 */
export function subscribeAgentEvents(cb: (state: AgentChatState) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

const emit = coalesced(() => {
  const host = getHost();
  if (host && !host.isDestroyed()) host.webContents.send('agent:event', state);
  // Notify any in-process subscribers (the bridge server) with the same snapshot
  // the renderer just got. Isolated per-callback so a throwing subscriber neither
  // breaks its peers nor the renderer push above.
  for (const cb of subscribers) {
    try {
      cb(state);
    } catch {
      // A subscriber must never break the loop's fan-out.
    }
  }
});

/* ── message helpers ────────────────────────────────────────────────────── */

/** One tool result for the transcript (AI SDK tool-message content shape). */
type ToolResultPartLite = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: { type: 'text'; value: string } | { type: 'error-text'; value: string };
};

function toolResult(
  callId: string,
  toolName: string,
  content: string,
  isError?: boolean,
): ToolResultPartLite {
  return {
    type: 'tool-result',
    toolCallId: callId,
    toolName,
    output: isError ? { type: 'error-text', value: content } : { type: 'text', value: content },
  };
}

function recordEdits(turnId: string, changes: AppliedChange[] | undefined): void {
  if (!changes) return;
  for (const c of changes) {
    state.edits.push({
      id: uid('edit'),
      turnId,
      path: c.path,
      kind: c.kind,
      before: c.before,
      after: c.after,
      status: 'applied',
      timestamp: Date.now(),
    });
  }
}

/** Compact, model-facing context for the first user turn (captures + tab). */
function buildUserText(input: AgentSendInput, ws: WorkspaceSummary | null): string {
  const lines: string[] = [
    ws
      ? `Workspace: ${ws.name} (${ws.files.length} files indexed).`
      : 'No workspace is open — file tools (read/list/grep/edit) are unavailable. Browser and page tools (console/DOM/network/eval) work normally.',
  ];
  if (input.tabId) {
    const rec = getTab(input.tabId);
    const url = rec?.view?.webContents.getURL();
    // Scrub: URLs can carry tokens in query params (and captures carry page text).
    if (url) lines.push(`Active web tab URL: ${scrubText(url)}`);
  }
  lines.push('', `User request: ${input.prompt.trim()}`);
  if (input.captures.length > 0) {
    lines.push('', 'Attached context (selected by the user):');
    for (const cap of input.captures) {
      if (cap.kind === 'console-error') {
        const loc = cap.source ? ` @ ${scrubText(cap.source.url)}` : '';
        lines.push(`- console error: ${scrubText(cap.message)}${loc}`);
      } else {
        const attrs = Object.entries(cap.attributes).slice(0, 6).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
        lines.push(`- <${cap.tagName.toLowerCase()}> selector="${cap.selector}"${cap.text ? ` text="${cap.text.slice(0, 80)}"` : ''}${attrs ? ` [${attrs}]` : ''}`);
      }
    }
    lines.push('', 'Use the tools to confirm against the live page and the workspace files.');
  }
  return lines.join('\n');
}

/* ── parking (approval / ask_user) ──────────────────────────────────────── */

// Settle-then-replace: never leave a live resolver from a prior call behind, so
// a late agent:approve-tool / agent:respond can't resolve the wrong parked
// promise. The turnId+callId guards in approveTool/respond are the primary gate;
// this is belt-and-suspenders for the resolver lifecycle.
function waitForApproval(): Promise<boolean> {
  approvalResolver?.(false);
  return new Promise((resolve) => {
    approvalResolver = resolve;
  });
}

function waitForAnswers(): Promise<AgentAnswers> {
  answersResolver?.({});
  return new Promise((resolve) => {
    answersResolver = resolve;
  });
}

/* ── the loop ───────────────────────────────────────────────────────────── */

type RunOpts = {
  auth: ModelAuth;
  /** Custom endpoints (custom:<id>) carry their resolved baseURL; undefined for built-ins. */
  baseUrl?: string;
  model: string;
  provider: AgentSendInput['provider'];
  ws: WorkspaceSummary | null;
  tabId?: string;
  turnId: string;
  signal: AbortSignal;
  /** How much the agent may do without asking (Settings → Agent, §B4). */
  approvalMode: AgentApprovalMode;
  /** Path globs the agent may never edit (passed to the tool context). */
  denyGlobs: string[];
};

async function runLoop(opts: RunOpts): Promise<void> {
  const ctx: ToolContext = {
    ws: opts.ws,
    tabId: opts.tabId,
    signal: opts.signal,
    denyGlobs: opts.denyGlobs,
  };
  // Build the model + tool set once per turn (provider/model/auth are fixed for it).
  const model = buildModel(opts.provider, opts.model, opts.auth, opts.baseUrl);
  const tools = aiTools(listMcpTools());
  // Anthropic OAuth (subscription) requests are rejected unless the system prompt
  // starts with the Claude-Code identity line — prepend it for that path only.
  const baseSystem =
    opts.auth.mode === 'oauth' && opts.provider === 'anthropic'
      ? `${CLAUDE_CODE_SYSTEM_PREFIX}\n\n${SYSTEM_PROMPT}`
      : SYSTEM_PROMPT;
  // Fold the repo's own instruction file (AGENTS.md / CLAUDE.md) into the system
  // prompt so the agent follows project conventions (Track B §B2). Appended AFTER
  // the Claude-Code prefix so the Anthropic-OAuth first-line requirement holds.
  const instructions = await loadWorkspaceInstructions(opts.ws);
  const system = instructions ? `${baseSystem}\n\n---\n\n${instructions}` : baseSystem;
  // The ChatGPT codex backend (openai-codex) needs store:false, rejects
  // max_output_tokens, AND requires the system prompt in the Responses API's
  // top-level `instructions` field — it 400s `{"detail":"Instructions are
  // required"}` when the system prompt is only an `input` message. So for codex
  // we route `system` → `instructions` (and omit the streamText `system` below,
  // so it isn't also duplicated into `input`).
  const codexBackend = opts.provider === 'openai-codex';
  const providerOptions = codexBackend
    ? { openai: { store: false, instructions: system } }
    : undefined;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (opts.signal.aborted) return finish('completed', '(stopped by user)');
    state.status = 'thinking';

    // Create the assistant message up front so streamed text deltas render live
    // (real token streaming); tool calls are attached once the step settles.
    const assistantMsg: AgentMessage = {
      id: uid('m'),
      role: 'assistant',
      parts: [{ type: 'text', text: '' }],
      timestamp: Date.now(),
    };
    const textPart = assistantMsg.parts[0] as AgentTextPart;
    state.messages.push(assistantMsg);
    emit();

    // Reasoning ("extended thinking") streams on a separate channel; render it as
    // a collapsible block ABOVE the answer (v3 §5-A). Created lazily on the first
    // delta and kept display-only (never pushed into the provider transcript).
    let reasoningPart: AgentReasoningPart | null = null;

    let toolUses: { id: string; name: string; input: unknown }[];
    try {
      const res = streamText({
        model,
        // codex carries the system prompt in providerOptions.openai.instructions
        // (see above), so don't also pass it here or it lands twice.
        system: codexBackend ? undefined : system,
        messages: transcript,
        tools,
        maxOutputTokens: codexBackend ? undefined : AGENT_MAX_TOKENS,
        providerOptions,
        abortSignal: opts.signal,
      });
      // Consume the stream for live text; the assembled tool calls + usage come
      // from the settled promises afterwards.
      for await (const part of res.fullStream) {
        if (part.type === 'text-delta') {
          textPart.text += part.text;
          emit();
        } else if (part.type === 'reasoning-delta') {
          if (!reasoningPart) {
            reasoningPart = { type: 'reasoning', text: '' };
            // Insert before the (parts[0]) text so it reads thought → answer.
            assistantMsg.parts.unshift(reasoningPart);
          }
          reasoningPart.text += part.text;
          emit();
        }
      }
      const calls = await res.toolCalls;
      const usage = await res.usage;
      toolUses = calls.map((c) => ({ id: c.toolCallId, name: c.toolName, input: c.input }));
      state.usage.inputTokens += usage.inputTokens ?? 0;
      state.usage.outputTokens += usage.outputTokens ?? 0;
    } catch (err) {
      // Drop the optimistic streaming bubble if nothing was streamed into it, so
      // a failed/aborted step doesn't leave an empty assistant message behind.
      // Reasoning-only content still counts — keep a thinking-only bubble.
      if (!textPart.text.trim() && !reasoningPart?.text.trim()) {
        const i = state.messages.indexOf(assistantMsg);
        if (i !== -1) state.messages.splice(i, 1);
      }
      if (opts.signal.aborted) return finish('completed', '(stopped by user)');
      return finish(
        'failed',
        undefined,
        humanizeModelError(err, opts.provider, opts.model),
      );
    }

    // Attach tool-call cards to the streamed message + mirror the turn into the
    // transcript (a valid tool_use the next step answers with a tool_result).
    const calls: ToolCall[] = toolUses.map((t) => ({
      id: t.id,
      name: t.name,
      input: t.input,
      state: 'running',
    }));
    // Drop the empty optimistic text part when the step produced only tool calls,
    // but keep any reasoning part so the thinking stays visible above the tools.
    if (!textPart.text.trim()) {
      assistantMsg.parts = assistantMsg.parts.filter((p) => p.type === 'reasoning');
    }
    for (const c of calls) assistantMsg.parts.push({ type: 'tool', call: c });

    const assistantContent: Array<
      | { type: 'text'; text: string }
      | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
    > = [];
    if (textPart.text.trim()) assistantContent.push({ type: 'text', text: textPart.text });
    for (const t of toolUses) {
      assistantContent.push({ type: 'tool-call', toolCallId: t.id, toolName: t.name, input: t.input });
    }
    transcript.push({ role: 'assistant', content: assistantContent });
    emit();

    if (calls.length === 0) return finish('completed');

    // Execute each tool call; collect one tool_result per call (transcript stays valid).
    state.status = 'working';
    emit();
    const toolResultParts: ToolResultPartLite[] = [];
    for (const call of calls) {
      if (opts.signal.aborted) {
        call.state = 'aborted';
        toolResultParts.push(toolResult(call.id, call.name, 'aborted by user', true));
        continue;
      }

      // ask_user: park the turn, surface the questions, resume with answers.
      if (call.name === ASK_USER) {
        const answered = await handleAskUser(opts.turnId, call, opts.signal);
        toolResultParts.push(toolResult(call.id, call.name, answered.content, answered.isError));
        continue;
      }

      // Read-only mode: refuse mutations + code execution outright (don't even
      // prompt). Reads still run; sensitive read tools below still ask. (§B4)
      if (
        opts.approvalMode === 'read-only' &&
        (isWriteTool(call.name) || call.name === 'eval_js')
      ) {
        call.state = 'denied';
        call.resultText = 'Blocked: read-only mode.';
        emit();
        toolResultParts.push(
          toolResult(
            call.id,
            call.name,
            'Blocked: the agent is in read-only mode. Switch to Ask or Auto in Settings → Agent to allow edits and code execution.',
            true,
          ),
        );
        continue;
      }

      // Gated tools (eval_js / cookies / storage / terminal output): park for
      // explicit approval — unless the mode is `auto`, which auto-approves. (§B4)
      if (isGatedTool(call.name) && opts.approvalMode !== 'auto') {
        call.state = 'awaiting_approval';
        state.status = 'waiting_for_user';
        state.pendingApproval = {
          turnId: opts.turnId,
          callId: call.id,
          name: call.name,
          detail: describeToolInput(call.name, call.input),
        };
        emit();
        const approved = await waitForApproval();
        approvalResolver = null;
        state.pendingApproval = null;
        if (opts.signal.aborted) {
          call.state = 'aborted';
          toolResultParts.push(toolResult(call.id, call.name, 'aborted by user', true));
          continue;
        }
        if (!approved) {
          call.state = 'denied';
          call.resultText = 'Denied by the user.';
          state.status = 'working';
          emit();
          toolResultParts.push(toolResult(call.id, call.name, 'The user denied this tool call.', true));
          continue;
        }
        state.status = 'working';
        emit();
      }

      call.state = 'running';
      emit();
      const out = await callMcpTool(call.name, call.input, ctx);
      call.state = out.isError ? 'error' : 'ok';
      call.summary = out.summary;
      call.resultText = out.text;
      if (out.isError) call.error = out.text;
      recordEdits(opts.turnId, out.edits);
      emit();
      toolResultParts.push(toolResult(call.id, call.name, out.text, out.isError));
    }

    transcript.push({ role: 'tool', content: toolResultParts });
    if (opts.signal.aborted) return finish('completed', '(stopped by user)');
  }

  finish('completed', '(stopped — reached the step limit; ask me to continue)');
}

async function handleAskUser(
  turnId: string,
  call: ToolCall,
  signal: AbortSignal,
): Promise<{ content: string; isError?: boolean }> {
  const input = (call.input ?? {}) as { questions?: { question?: unknown; options?: unknown }[] };
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const questions = raw
    .map((q, i) => ({
      id: `${call.id}-q${i}`,
      question: typeof q.question === 'string' ? q.question : '',
      options: Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === 'string') : undefined,
    }))
    .filter((q) => q.question);
  if (questions.length === 0) {
    call.state = 'error';
    return { content: 'ask_user called with no questions.', isError: true };
  }
  call.state = 'running';
  call.summary = `asked ${questions.length} question${questions.length === 1 ? '' : 's'}`;
  state.status = 'waiting_for_user';
  state.pendingQuestions = { turnId, callId: call.id, questions };
  emit();
  const answers = await waitForAnswers();
  answersResolver = null;
  state.pendingQuestions = null;
  // Aborted while parked: record the call as aborted, not answered, so a resumed
  // conversation's transcript doesn't carry a fabricated "answer".
  if (signal.aborted) {
    call.state = 'aborted';
    return { content: 'aborted by user', isError: true };
  }
  call.state = 'ok';
  state.status = 'working';
  emit();
  const text = questions
    .map((q) => `Q: ${q.question}\nA: ${answers[q.id] ?? '(no answer)'}`)
    .join('\n\n');
  return { content: text || 'The user provided no answers.' };
}

function finish(status: AgentChatState['status'], note?: string, error?: string): void {
  if (note) {
    state.messages.push({ id: uid('m'), role: 'assistant', parts: [{ type: 'text', text: note }], timestamp: Date.now() });
  }
  state.status = status;
  state.error = error ?? null;
  state.pendingApproval = null;
  state.pendingQuestions = null;
  // Settle + drop any parked resolver so none leaks past the turn.
  approvalResolver?.(false);
  approvalResolver = null;
  answersResolver?.({});
  answersResolver = null;
  // Stop the lazy network capture this turn may have enabled — otherwise the
  // relay keeps buffering responses for the tab forever (the always-on path is
  // meant to stay Runtime-only when no agent turn is active).
  if (activeTabId) {
    setNetworkCapture(activeTabId, false);
    activeTabId = undefined;
  }
  controller = null;
  // Persist the conversation so far (best-effort, fire-and-forget) — each turn's
  // end updates the same session record, so list_sessions/read_session always
  // reflect the latest state.
  if (conversationId && state.messages.length > 0) void persistSession();
  emit();
}

/** Clip a tool result before persisting so a session file can't grow unbounded. */
function snapshotMessagesForSave(): AgentMessage[] {
  return state.messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) => {
      if (p.type !== 'tool') return p;
      const rt = p.call.resultText;
      return rt && rt.length > 4_000
        ? { ...p, call: { ...p.call, resultText: `${rt.slice(0, 4_000)}…` } }
        : p;
    }),
  }));
}

async function persistSession(): Promise<void> {
  if (!conversationId) return;
  const record: SessionRecord = {
    id: conversationId,
    title: conversationTitle || 'Untitled chat',
    createdAt: conversationStartedAt || Date.now(),
    updatedAt: Date.now(),
    provider: conversationProvider,
    model: conversationModel,
    messageCount: state.messages.length,
    messages: snapshotMessagesForSave(),
    usage: { ...state.usage },
  };
  await saveSession(record);
}

/* ── public API (handlers.ts) ───────────────────────────────────────────── */

/**
 * Resolve how a request authenticates. Built-in providers prefer an OAuth
 * subscription connection (Claude Pro/Max) when one is stored, refreshing the
 * token first; otherwise the stored API key. Custom endpoints (custom:<id>) carry
 * their baseURL and treat the key as optional (many local OpenAI-compatible
 * servers need none); built-in keyless (Ollama) runs no key. Shared by the turn
 * loop and the Settings "Test connection" probe so both auth identically.
 */
async function resolveTurnAuth(
  provider: AgentSendInput['provider'],
): Promise<
  { ok: true; auth: ModelAuth; baseUrl?: string } | { ok: false; reason: string }
> {
  let apiKey: string | null;
  try {
    apiKey = await getProviderApiKey(provider);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (isBuiltinProviderId(provider)) {
    let auth: ModelAuth | null = null;
    if (supportsOAuth(provider)) {
      let accessToken: string | null = null;
      try {
        accessToken = await getValidAccessToken(provider);
      } catch (err) {
        // The OAuth session is dead (getValidAccessToken just cleared it). Fall
        // back to a stored API key if any; else surface the reconnect message.
        if (!apiKey) return { ok: false, reason: (err as Error).message };
      }
      if (accessToken) auth = { mode: 'oauth', accessToken };
    }
    if (!auth) {
      if (!apiKey && !getProvider(provider).keyless) {
        return {
          ok: false,
          reason: supportsOAuth(provider)
            ? `no API key or OAuth connection for ${provider}`
            : `no API key configured for ${provider}`,
        };
      }
      auth = { mode: 'api-key', apiKey: apiKey ?? '' };
    }
    return { ok: true, auth };
  }
  const custom = await getCustomProvider(provider);
  if (!custom) return { ok: false, reason: `unknown custom provider ${provider}` };
  return { ok: true, auth: { mode: 'api-key', apiKey: apiKey ?? '' }, baseUrl: custom.baseUrl };
}

/**
 * A minimal live request to verify a provider's credentials work — for the
 * Settings "Test connection" button. Especially useful for OAuth providers,
 * which have no /models endpoint to probe (so the model-list path can't tell a
 * dead token from a working one). Resolves auth exactly like a turn, then runs a
 * tiny generateText against the provider's default model.
 */
export async function testProviderConnection(
  provider: AgentSendInput['provider'],
): Promise<{ ok: boolean; message: string }> {
  const resolved = await resolveTurnAuth(provider);
  if (!resolved.ok) return { ok: false, message: resolved.reason };
  const model = isBuiltinProviderId(provider) ? getProvider(provider).defaultModelId : '';
  if (!model) return { ok: false, message: 'No default model to test for this provider.' };
  try {
    const m = buildModel(provider, model, resolved.auth, resolved.baseUrl);
    const codexBackend = provider === 'openai-codex';
    const system =
      resolved.auth.mode === 'oauth' && provider === 'anthropic'
        ? CLAUDE_CODE_SYSTEM_PREFIX
        : undefined;
    await generateText({
      model: m,
      system,
      prompt: 'Reply with the single word: ok',
      maxOutputTokens: codexBackend ? undefined : 16,
      providerOptions: codexBackend ? { openai: { store: false } } : undefined,
    });
    return { ok: true, message: `Connection works — ${model} responded.` };
  } catch (err) {
    return { ok: false, message: humanizeModelError(err, provider, model) };
  }
}

export async function startTurn(input: AgentSendInput): Promise<AgentSendResult> {
  // `starting` closes the window between this check and `state.status` going
  // busy (there's an `await getProviderApiKey` before we set it), so two
  // near-simultaneous sends can't both set up a turn and clobber `controller`.
  if (busy() || starting) return { ok: false, reason: 'a turn is already in progress' };
  starting = true;
  try {
    if (!input.prompt || input.prompt.trim().length === 0) {
      return { ok: false, reason: 'enter a prompt' };
    }
    // AI Chat works without an open folder: file tools are disabled (the model
    // is told so in the prompt, and they return a friendly error if called), but
    // browser/page tools and a plain conversation still work. A workspace just
    // unlocks the file tools.
    let ws: WorkspaceSummary | null = null;
    try {
      ws = requireWorkspace().ws;
    } catch {
      ws = null;
    }
    const resolved = await resolveTurnAuth(input.provider);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const { auth, baseUrl } = resolved;

    const turnId = uid('turn');
    // Open (or continue) the conversation's saved-session identity. The id +
    // title are pinned on the first turn after a reset; provider/model track the
    // latest turn (the user may switch models mid-conversation).
    if (!conversationId) {
      conversationId = uid('session');
      conversationStartedAt = Date.now();
      conversationTitle = input.prompt.trim().split('\n')[0].slice(0, 60) || 'Untitled chat';
    }
    conversationProvider = input.provider;
    conversationModel = input.model;
    controller = new AbortController();
    activeTabId = input.tabId;
    state.turnId = turnId;
    state.status = 'thinking';
    state.error = null;
    state.pendingApproval = null;
    state.pendingQuestions = null;

    const userText = buildUserText(input, ws);
    const promptNote = input.captures.length > 0 ? `${input.prompt.trim()}\n\n(+${input.captures.length} attached capture${input.captures.length === 1 ? '' : 's'})` : input.prompt.trim();
    state.messages.push({ id: uid('m'), role: 'user', parts: [{ type: 'text', text: promptNote }], timestamp: Date.now() });
    transcript.push({ role: 'user', content: userText });
    emit();

    const agentSettings = getSettingsSync().agent;
    void runLoop({
      auth,
      baseUrl,
      model: input.model,
      provider: input.provider,
      ws,
      tabId: input.tabId,
      turnId,
      signal: controller.signal,
      approvalMode: agentSettings.approvalMode,
      denyGlobs: agentSettings.denyGlobs,
    }).catch((err) => finish('failed', undefined, (err as Error).message));

    return { ok: true, turnId };
  } finally {
    // By here the turn is set up (status busy) or we returned an error; either
    // way subsequent sends are gated by busy(), so releasing `starting` is safe.
    starting = false;
  }
}

export function abortTurn(turnId: string): boolean {
  if (state.turnId !== turnId || !controller) return false;
  controller.abort();
  // Unblock a parked turn so the loop can observe the abort and bail cleanly.
  approvalResolver?.(false);
  answersResolver?.({});
  return true;
}

export function respond(turnId: string, callId: string, answers: AgentAnswers): boolean {
  if (state.pendingQuestions?.turnId !== turnId || state.pendingQuestions?.callId !== callId) return false;
  if (!answersResolver) return false;
  answersResolver(answers ?? {});
  return true;
}

export function approveTool(turnId: string, callId: string, approved: boolean): boolean {
  if (state.pendingApproval?.turnId !== turnId || state.pendingApproval?.callId !== callId) return false;
  if (!approvalResolver) return false;
  approvalResolver(approved);
  return true;
}

export function acceptEdit(editId: string): boolean {
  const edit = state.edits.find((e) => e.id === editId);
  if (!edit || edit.status !== 'applied') return false;
  edit.status = 'accepted';
  emit();
  return true;
}

export async function revertEdit(editId: string): Promise<boolean> {
  const edit = state.edits.find((e) => e.id === editId);
  if (!edit || edit.status !== 'applied') return false;
  let ws: WorkspaceSummary;
  try {
    ws = requireWorkspace().ws;
  } catch {
    return false;
  }
  try {
    await revertOnDisk(ws, edit);
  } catch {
    return false;
  }
  edit.status = 'reverted';
  emit();
  return true;
}

async function revertOnDisk(ws: WorkspaceSummary, edit: AgentEdit): Promise<void> {
  if (edit.kind === 'edit' && edit.before !== null) {
    await writeFileForEditor(ws.root, edit.path, edit.before);
    return;
  }
  if (edit.kind === 'create') {
    const { abs } = resolveWorkspacePath(ws.root, edit.path);
    const lst = await fs.lstat(abs).catch(() => null);
    if (lst && !lst.isSymbolicLink() && lst.isFile()) {
      const real = await fs.realpath(abs);
      if (isInsideRoot(ws.root, real)) await fs.unlink(abs);
    }
  }
}

export function snapshot(): AgentChatState {
  return state;
}

export function reset(): boolean {
  if (busy()) return false;
  // Clear the transcript but KEEP edits the user hasn't decided on yet: those
  // files are still modified on disk, and dropping them would orphan the only
  // in-app affordance to revert (the `before` content lives on the edit). Edits
  // the user already accepted/reverted are resolved, so they drop with the chat.
  const keptEdits = state.edits.filter((e) => e.status === 'applied');
  state = emptyAgentChatState();
  state.edits = keptEdits;
  transcript = [];
  // The prior conversation was persisted on its last turn's finish(); drop its id
  // so the next turn begins (and saves to) a fresh session.
  conversationId = null;
  emit();
  return true;
}
