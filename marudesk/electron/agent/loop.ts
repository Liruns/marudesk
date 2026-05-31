import fs from 'node:fs/promises';
import type {
  AgentAnswers,
  AgentChatState,
  AgentEdit,
  AgentMessage,
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
import { requireWorkspace } from '../ipc/define-handler';
import { getHost, getTab, setNetworkCapture } from '../browser/state';
import { isInsideRoot, resolveWorkspacePath } from '../fs-safe';
import { writeFileForEditor } from '../workspace';
import { streamText, type ModelMessage } from 'ai';
import { buildModel, aiTools, type ModelAuth } from './model';
import {
  ASK_USER,
  GATED_TOOLS,
  TOOL_SCHEMAS,
  describeToolInput,
  executeTool,
  type ToolContext,
} from './tools';

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
let seq = 0;

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${++seq}`;
}

function busy(): boolean {
  return state.status === 'thinking' || state.status === 'working' || state.status === 'waiting_for_user';
}

/* ── renderer push (coalesced) ──────────────────────────────────────────── */

const emit = coalesced(() => {
  const host = getHost();
  if (host && !host.isDestroyed()) host.webContents.send('agent:event', state);
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
function buildUserText(input: AgentSendInput, ws: WorkspaceSummary): string {
  const lines: string[] = [`Workspace: ${ws.name} (${ws.files.length} files indexed).`];
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
  ws: WorkspaceSummary;
  tabId?: string;
  turnId: string;
  signal: AbortSignal;
};

async function runLoop(opts: RunOpts): Promise<void> {
  const ctx: ToolContext = { ws: opts.ws, tabId: opts.tabId, signal: opts.signal };
  // Build the model + tool set once per turn (provider/model/auth are fixed for it).
  const model = buildModel(opts.provider, opts.model, opts.auth, opts.baseUrl);
  const tools = aiTools(TOOL_SCHEMAS);
  // Anthropic OAuth (subscription) requests are rejected unless the system prompt
  // starts with the Claude-Code identity line — prepend it for that path only.
  const system =
    opts.auth.mode === 'oauth' && opts.provider === 'anthropic'
      ? `${CLAUDE_CODE_SYSTEM_PREFIX}\n\n${SYSTEM_PROMPT}`
      : SYSTEM_PROMPT;
  // The ChatGPT codex backend (openai-codex) requires store:false and rejects
  // max_output_tokens — omit the cap and pass the flag for that provider only.
  const codexBackend = opts.provider === 'openai-codex';
  const providerOptions = codexBackend ? { openai: { store: false } } : undefined;

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

    let toolUses: { id: string; name: string; input: unknown }[];
    try {
      const res = streamText({
        model,
        system,
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
      if (!textPart.text.trim()) {
        const i = state.messages.indexOf(assistantMsg);
        if (i !== -1) state.messages.splice(i, 1);
      }
      if (opts.signal.aborted) return finish('completed', '(stopped by user)');
      return finish('failed', undefined, (err as Error).message);
    }

    // Attach tool-call cards to the streamed message + mirror the turn into the
    // transcript (a valid tool_use the next step answers with a tool_result).
    const calls: ToolCall[] = toolUses.map((t) => ({
      id: t.id,
      name: t.name,
      input: t.input,
      state: 'running',
    }));
    if (!textPart.text.trim()) assistantMsg.parts = [];
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

      // Gated tools (eval_js): park for explicit approval.
      if (GATED_TOOLS.has(call.name)) {
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
      const out = await executeTool(call.name, call.input, ctx);
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
  emit();
}

/* ── public API (handlers.ts) ───────────────────────────────────────────── */

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
    let ws: WorkspaceSummary;
    try {
      ws = requireWorkspace().ws;
    } catch {
      return { ok: false, reason: 'open a workspace first' };
    }
    let apiKey: string | null;
    try {
      apiKey = await getProviderApiKey(input.provider);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    // Resolve how this turn authenticates. Built-in providers prefer an OAuth
    // subscription connection (Claude Pro/Max) when one is stored, refreshing the
    // token first; otherwise the stored API key. Custom endpoints (custom:<id>)
    // carry their baseURL and treat the key as optional (many local
    // OpenAI-compatible servers need none); built-in keyless (Ollama) runs no key.
    let auth: ModelAuth | null = null;
    let baseUrl: string | undefined;
    if (isBuiltinProviderId(input.provider)) {
      if (supportsOAuth(input.provider)) {
        let accessToken: string | null = null;
        try {
          accessToken = await getValidAccessToken(input.provider);
        } catch (err) {
          // The OAuth session is dead (and getValidAccessToken just cleared it).
          // Fall back to a stored API key if there is one; otherwise surface the
          // reconnect message.
          if (!apiKey) return { ok: false, reason: (err as Error).message };
        }
        if (accessToken) auth = { mode: 'oauth', accessToken };
      }
      if (!auth) {
        if (!apiKey && !getProvider(input.provider).keyless) {
          return {
            ok: false,
            reason: supportsOAuth(input.provider)
              ? `no API key or OAuth connection for ${input.provider}`
              : `no API key configured for ${input.provider}`,
          };
        }
        auth = { mode: 'api-key', apiKey: apiKey ?? '' };
      }
    } else {
      const custom = await getCustomProvider(input.provider);
      if (!custom) {
        return { ok: false, reason: `unknown custom provider ${input.provider}` };
      }
      baseUrl = custom.baseUrl;
      auth = { mode: 'api-key', apiKey: apiKey ?? '' };
    }
    // Unreachable — both branches above assign or return — but it narrows the type.
    if (!auth) return { ok: false, reason: `could not resolve auth for ${input.provider}` };

    const turnId = uid('turn');
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

    void runLoop({
      auth,
      baseUrl,
      model: input.model,
      provider: input.provider,
      ws,
      tabId: input.tabId,
      turnId,
      signal: controller.signal,
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
  emit();
  return true;
}
