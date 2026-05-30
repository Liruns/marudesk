import fs from 'node:fs/promises';
import type {
  AgentAnswers,
  AgentChatState,
  AgentEdit,
  AgentPart,
  AgentSendInput,
  AgentSendResult,
  ToolCall,
} from '../../shared/agent';
import { emptyAgentChatState } from '../../shared/agent';
import type { AppliedChange } from '../../shared/patch';
import type { WorkspaceSummary } from '../../shared/workspace';
import { scrubText } from '../../shared/scrub';
import { getProviderApiKey } from '../secrets';
import { requireWorkspace } from '../ipc/define-handler';
import { getHost, getTab, setNetworkCapture } from '../browser/state';
import { isInsideRoot, resolveWorkspacePath } from '../fs-safe';
import { writeFileForEditor } from '../workspace';
import { getAgentDriver, type LoopContent, type LoopMessage } from './driver';
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
let transcript: LoopMessage[] = [];
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

let emitScheduled = false;
function emit(): void {
  if (emitScheduled) return;
  emitScheduled = true;
  setImmediate(() => {
    emitScheduled = false;
    const host = getHost();
    if (host && !host.isDestroyed()) host.webContents.send('agent:event', state);
  });
}

/* ── message helpers ────────────────────────────────────────────────────── */

function pushAssistant(text: string, calls: ToolCall[]): void {
  const parts: AgentPart[] = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const call of calls) parts.push({ type: 'tool', call });
  state.messages.push({ id: uid('m'), role: 'assistant', parts, timestamp: Date.now() });
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
  apiKey: string;
  model: string;
  provider: AgentSendInput['provider'];
  ws: WorkspaceSummary;
  tabId?: string;
  turnId: string;
  signal: AbortSignal;
};

async function runLoop(opts: RunOpts): Promise<void> {
  const driver = getAgentDriver(opts.provider)!; // existence checked in startTurn
  const ctx: ToolContext = { ws: opts.ws, tabId: opts.tabId, signal: opts.signal };

  for (let step = 0; step < MAX_STEPS; step++) {
    if (opts.signal.aborted) return finish('completed', '(stopped by user)');
    state.status = 'thinking';
    emit();

    let result;
    try {
      result = await driver.step({
        apiKey: opts.apiKey,
        model: opts.model,
        system: SYSTEM_PROMPT,
        messages: transcript,
        tools: TOOL_SCHEMAS,
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal.aborted) return finish('completed', '(stopped by user)');
      return finish('failed', undefined, (err as Error).message);
    }

    state.usage.inputTokens += result.usage.inputTokens;
    state.usage.outputTokens += result.usage.outputTokens;

    // Build the assistant turn (display + transcript) together.
    const calls: ToolCall[] = result.toolUses.map((t) => ({
      id: t.id,
      name: t.name,
      input: t.input,
      state: 'running',
    }));
    pushAssistant(result.text, calls);
    const assistantContent: LoopContent[] = [];
    if (result.text.trim()) assistantContent.push({ type: 'text', text: result.text });
    for (const t of result.toolUses) {
      assistantContent.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
    }
    transcript.push({ role: 'assistant', content: assistantContent });
    emit();

    if (calls.length === 0) return finish('completed');

    // Execute each tool call; collect one tool_result per call (transcript stays valid).
    state.status = 'working';
    emit();
    const toolResults: LoopContent[] = [];
    for (const call of calls) {
      if (opts.signal.aborted) {
        call.state = 'aborted';
        toolResults.push({ type: 'tool_result', toolUseId: call.id, content: 'aborted by user', isError: true });
        continue;
      }

      // ask_user: park the turn, surface the questions, resume with answers.
      if (call.name === ASK_USER) {
        const answered = await handleAskUser(opts.turnId, call, opts.signal);
        toolResults.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: answered.content,
          isError: answered.isError,
        });
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
          toolResults.push({ type: 'tool_result', toolUseId: call.id, content: 'aborted by user', isError: true });
          continue;
        }
        if (!approved) {
          call.state = 'denied';
          call.resultText = 'Denied by the user.';
          state.status = 'working';
          emit();
          toolResults.push({ type: 'tool_result', toolUseId: call.id, content: 'The user denied this tool call.', isError: true });
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
      toolResults.push({ type: 'tool_result', toolUseId: call.id, content: out.text, isError: out.isError });
    }

    transcript.push({ role: 'user', content: toolResults });
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
    if (!getAgentDriver(input.provider)) {
      return { ok: false, reason: `agent mode currently supports Anthropic; ${input.provider} support is coming` };
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
    if (!apiKey) return { ok: false, reason: `no API key configured for ${input.provider}` };

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
    transcript.push({ role: 'user', content: [{ type: 'text', text: userText }] });
    emit();

    void runLoop({
      apiKey,
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
