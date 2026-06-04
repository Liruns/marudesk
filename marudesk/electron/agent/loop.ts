import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
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
import { getProvider, isBuiltinProviderId, isProviderId, MODELS } from '../../shared/providers';
import { coalesced } from '../coalesce';
import { CLAUDE_CODE_SYSTEM_PREFIX } from '../oauth/config';
import { getSettingsSync } from '../settings';
import type { AgentApprovalMode, ModelRef, ReasoningEffort } from '../../shared/settings';
import { requireWorkspace } from '../ipc/define-handler';
import { getHost, getTab, setNetworkCapture } from '../browser/state';
import { isInsideRoot, resolveWorkspacePath } from '../fs-safe';
import { writeFileForEditor } from '../workspace';
import { streamText, generateText, type ModelMessage } from 'ai';
import { buildModel, aiTools, humanizeModelError, isFailoverError, type ModelAuth } from './model';
import { loadWorkspaceInstructions } from './instructions';
import { ASK_USER, describeToolInput, type ToolContext } from './tools';
import { callMcpTool, isGatedTool, isWriteTool, listMcpTools } from './mcp';
import { deleteSession, listSessions, readSession, saveSession } from './sessions-store';
import { clearReadTracker } from './read-tracker';
import { keywordModePreamble } from './keyword-modes';
import { buildProviderOptions, maxTokensForTurn } from './reasoning-config';
import type { SessionRecord, SessionSummary } from '../../shared/context';
import { resolveProviderAuth } from './resolve-auth';

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

/**
 * Plan-mode addendum (claude-code plan mode parity). Appended to the system
 * prompt when {@link AgentApprovalMode} is `plan`: the agent researches with
 * read tools but is barred from editing/eval and must end with a concrete plan
 * the user can approve before switching to Ask/Auto to execute it.
 */
/** Marker prefixing the compaction summary in the rebuilt transcript (codex SUMMARY_PREFIX). */
const SUMMARY_PREFIX = 'Summary of the earlier conversation (compacted to save context):';

/** The summarization instruction sent to the model for `/compact`. */
const COMPACT_INSTRUCTION = `Summarize the conversation below so it can replace the full history while preserving everything needed to continue the work. Capture: the user's goals and constraints, key decisions and their rationale, files and code touched, what was tried and what worked or failed, current state, and concrete next steps. Be specific (file paths, function names, error signatures) but concise. Output only the summary prose — no preamble.`;

const PLAN_MODE_SYSTEM = `PLAN MODE IS ACTIVE. Do NOT edit files, run code, or change anything — write tools and eval are blocked this turn. Investigate with read/search tools, then end your reply with a concrete, ordered implementation plan: the files you would touch, the change in each, and how you would verify it. The user will review the plan and switch out of plan mode to execute it.`;

/* ── module state ───────────────────────────────────────────────────────── */

let state: AgentChatState = emptyAgentChatState();
// The provider-neutral running transcript (multi-turn). Kept valid at all times
// (every tool_use is answered by a tool_result) so a later turn can reuse it.
let transcript: ModelMessage[] = [];
let controller: AbortController | null = null;
/** Approval decision from the UI: approved/denied, plus "always for this session". */
type ApprovalDecision = { approved: boolean; always: boolean };
let approvalResolver: ((decision: ApprovalDecision) => void) | null = null;
/**
 * Gated tools the user chose to "Allow always" for this conversation. Future
 * calls to a tool in this set skip the approval prompt (claude-code "Allow
 * always" parity). Cleared on reset/resume so it never leaks across conversations.
 */
const sessionAllowedTools = new Set<string>();
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
  // Keyword modes (e.g. "ulw"/ultrawork): steer the model via a prepended
  // preamble. Applied to the model-facing text only — the chat shows the
  // original message unchanged.
  const preamble = keywordModePreamble(input.prompt);
  if (preamble) lines.push('', preamble);
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

/* ── post-edit verify hook (claude-code / codex PostToolUse) ─────────────── */

const execAsync = promisify(exec);
const VERIFY_TIMEOUT_MS = 120_000;
const VERIFY_OUTPUT_MAX = 2000;

/**
 * Run the user's configured post-edit verify command (Settings → Agent) at the
 * end of a turn that edited files, and return a PASS/FAIL note to fold into the
 * conversation — so a broken edit surfaces immediately and is in context for the
 * next turn. Returns null when the hook is off, no workspace is open, or the turn
 * made no edits. The command is user-configured (trusted, opt-in); it runs in the
 * workspace root with a hard timeout.
 */
async function runVerifyNote(turnId: string, ws: WorkspaceSummary | null): Promise<string | null> {
  const cmd = getSettingsSync().agent.verifyCommand.trim();
  if (!cmd || !ws) return null;
  // Only verify when this turn actually changed files on disk.
  if (!state.edits.some((e) => e.turnId === turnId)) return null;
  state.status = 'working';
  emit();
  let passed = false;
  let detail: string;
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: ws.root,
      timeout: VERIFY_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    passed = true;
    detail = `${stdout}${stderr}`.trim();
  } catch (err) {
    const e = err as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
    detail = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message || 'command failed';
    if (e.killed) detail = `timed out after ${VERIFY_TIMEOUT_MS / 1000}s\n${detail}`;
  }
  const tail = scrubText(detail).slice(-VERIFY_OUTPUT_MAX);
  return `\n\n---\n**Post-edit verify** \`${cmd}\`: ${passed ? '✓ PASS' : '✗ FAIL'}${
    tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ''
  }`;
}

/* ── parking (approval / ask_user) ──────────────────────────────────────── */

// Settle-then-replace: never leave a live resolver from a prior call behind, so
// a late agent:approve-tool / agent:respond can't resolve the wrong parked
// promise. The turnId+callId guards in approveTool/respond are the primary gate;
// this is belt-and-suspenders for the resolver lifecycle.
function waitForApproval(): Promise<ApprovalDecision> {
  approvalResolver?.({ approved: false, always: false });
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
  /** Standard reasoning effort (Settings → Agent) — applied only when the model reasons. */
  reasoningEffort: ReasoningEffort;
  /** Whether the selected model is a reasoning model (catalog flag) — gates the effort knob. */
  modelReasoning: boolean;
  /** User's standing system instructions (Settings → Agent), prepended to the prompt. */
  customInstructions: string;
  /**
   * Unattended bridge mode (Settings → Remote → "Skip approvals"): the desktop is
   * running headless for a paired phone, so gated tools auto-run instead of parking
   * for approval — the same effect as `auto`, but scoped to "the server is exposed
   * AND the user opted in". `read-only` still refuses writes/eval; this only skips
   * the `ask`-mode gate. See docs/t2-secure-pairing-design.md.
   */
  unattended: boolean;
  /**
   * Ordered model fail-over chain (Settings → Agent). Empty when the toggle is
   * off. On a rate-limit/5xx the loop retries the current step on the next
   * *connected* entry; the primary (provider/model above) is implicitly first
   * and never reused.
   */
  fallbacks: ModelRef[];
};

/**
 * The per-provider scaffolding for the model currently driving the turn —
 * bundled so a mid-turn fail-over can swap all of it atomically (the system
 * prompt, codex routing, and the reasoning/token knobs all depend on which
 * provider/model is active, not just the model handle).
 */
type ActiveTurnModel = {
  provider: AgentSendInput['provider'];
  modelId: string;
  model: ReturnType<typeof buildModel>;
  system: string;
  codexBackend: boolean;
  providerOptions: ReturnType<typeof buildProviderOptions>;
  maxOutputTokens: number | undefined;
};

async function runLoop(opts: RunOpts): Promise<void> {
  const ctx: ToolContext = {
    ws: opts.ws,
    tabId: opts.tabId,
    signal: opts.signal,
    denyGlobs: opts.denyGlobs,
    provider: opts.provider,
    model: opts.model,
  };
  const tools = aiTools(listMcpTools());
  // Fold the repo's own instruction file (AGENTS.md / CLAUDE.md) into the system
  // prompt so the agent follows project conventions (Track B §B2).
  const wsInstructions = await loadWorkspaceInstructions(opts.ws);

  // Build the per-provider scaffolding for a given model in ONE place, so a
  // mid-turn fail-over (pickNextFallback) can rebuild all of it for the new
  // provider — not just the model handle:
  //  - Anthropic OAuth (subscription) is rejected unless the system prompt starts
  //    with the Claude-Code identity line; prepend it for that path only, then
  //    fold the user's standing instructions + workspace AGENTS/CLAUDE after it.
  //  - The ChatGPT codex backend (openai-codex) routes `system` → the Responses
  //    API `instructions` field (it 400s otherwise) and rejects max_output_tokens.
  const activate = (a: {
    provider: AgentSendInput['provider'];
    modelId: string;
    auth: ModelAuth;
    baseUrl?: string;
    modelReasoning: boolean;
  }): ActiveTurnModel => {
    const baseSystem =
      a.auth.mode === 'oauth' && a.provider === 'anthropic'
        ? `${CLAUDE_CODE_SYSTEM_PREFIX}\n\n${SYSTEM_PROMPT}`
        : SYSTEM_PROMPT;
    const planAddendum = opts.approvalMode === 'plan' ? PLAN_MODE_SYSTEM : null;
    const system = [baseSystem, planAddendum, opts.customInstructions, wsInstructions]
      .filter((s): s is string => !!s && !!s.trim())
      .join('\n\n---\n\n');
    const codexBackend = a.provider === 'openai-codex';
    return {
      provider: a.provider,
      modelId: a.modelId,
      model: buildModel(a.provider, a.modelId, a.auth, a.baseUrl),
      system,
      codexBackend,
      providerOptions: buildProviderOptions(a.provider, system, a.modelReasoning, opts.reasoningEffort),
      maxOutputTokens: codexBackend
        ? undefined
        : maxTokensForTurn(a.provider, a.modelReasoning, opts.reasoningEffort),
    };
  };

  let current = activate({
    provider: opts.provider,
    modelId: opts.model,
    auth: opts.auth,
    baseUrl: opts.baseUrl,
    modelReasoning: opts.modelReasoning,
  });

  // Fail-over bookkeeping: never retry a model already tried this turn (seed with
  // the primary). `pickNextFallback` walks the configured chain and returns the
  // first *connected* candidate (resolving its creds), or null when spent.
  const triedModels = new Set<string>([`${opts.provider}::${opts.model}`]);
  const pickNextFallback = async (): Promise<ActiveTurnModel | null> => {
    for (const ref of opts.fallbacks) {
      const key = `${ref.provider}::${ref.model}`;
      if (triedModels.has(key)) continue;
      triedModels.add(key);
      const candidateProvider = ref.provider as AgentSendInput['provider'];
      const resolved = await resolveProviderAuth(candidateProvider);
      if (!resolved.ok) continue; // not connected (no key / dead OAuth) → skip
      const modelReasoning =
        MODELS.find((m) => m.provider === candidateProvider && m.id === ref.model)?.reasoning ?? false;
      return activate({
        provider: candidateProvider,
        modelId: ref.model,
        auth: resolved.auth,
        baseUrl: resolved.baseUrl,
        modelReasoning,
      });
    }
    return null;
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    if (opts.signal.aborted) return finish('completed', 'Stopped');
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
        model: current.model,
        // codex carries the system prompt in providerOptions.openai.instructions
        // (see above), so don't also pass it here or it lands twice.
        system: current.codexBackend ? undefined : current.system,
        messages: transcript,
        tools,
        maxOutputTokens: current.maxOutputTokens,
        providerOptions: current.providerOptions,
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
      if (opts.signal.aborted) return finish('completed', 'Stopped');
      // Provider exhausted (429) or a transient server error (5xx): fall over to
      // the next configured model and retry THIS step. The transcript is
      // provider-neutral, so only the per-provider scaffolding swaps; once we
      // switch, the rest of the turn stays on the new model.
      if (isFailoverError(err)) {
        const next = await pickNextFallback();
        if (next) {
          // Discard any partial bubble from the failed attempt; the retry makes a
          // fresh one. (429 usually fires before any text streams.)
          const i = state.messages.indexOf(assistantMsg);
          if (i !== -1) state.messages.splice(i, 1);
          current = next;
          emit();
          step--; // re-run this step index on the new model
          continue;
        }
      }
      return finish(
        'failed',
        undefined,
        humanizeModelError(err, current.provider, current.modelId),
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

    if (calls.length === 0) {
      // Post-edit verify hook: if this turn changed files and a verify command is
      // configured, run it and fold the result into this assistant message (UI +
      // model context) before completing.
      const note = await runVerifyNote(opts.turnId, opts.ws);
      if (note) {
        assistantMsg.parts.push({ type: 'text', text: note });
        assistantContent.push({ type: 'text', text: note });
        emit();
      }
      return finish('completed');
    }

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

      // Read-only and plan modes: refuse mutations + code execution outright
      // (don't even prompt). Reads still run; sensitive read tools below still
      // ask. Plan mode additionally steers the model toward a plan via the
      // system addendum. (§B4)
      if (
        (opts.approvalMode === 'read-only' || opts.approvalMode === 'plan') &&
        (isWriteTool(call.name) || call.name === 'eval_js')
      ) {
        const planning = opts.approvalMode === 'plan';
        call.state = 'denied';
        call.resultText = planning ? 'Blocked: plan mode.' : 'Blocked: read-only mode.';
        emit();
        toolResultParts.push(
          toolResult(
            call.id,
            call.name,
            planning
              ? 'Blocked: plan mode is active — do not edit. Finish researching and present a step-by-step plan; the user will switch to Ask or Auto to execute it.'
              : 'Blocked: the agent is in read-only mode. Switch to Ask or Auto in Settings → Agent to allow edits and code execution.',
            true,
          ),
        );
        continue;
      }

      // Gated tools (eval_js / cookies / storage / terminal output): park for
      // explicit approval — unless the mode is `auto` or the bridge is in
      // unattended mode, which auto-approve, or the user already chose "Allow
      // always" for this tool this conversation. (§B4)
      if (
        isGatedTool(call.name) &&
        opts.approvalMode !== 'auto' &&
        !opts.unattended &&
        !sessionAllowedTools.has(call.name)
      ) {
        call.state = 'awaiting_approval';
        state.status = 'waiting_for_user';
        state.pendingApproval = {
          turnId: opts.turnId,
          callId: call.id,
          name: call.name,
          detail: describeToolInput(call.name, call.input),
        };
        emit();
        const decision = await waitForApproval();
        approvalResolver = null;
        state.pendingApproval = null;
        if (opts.signal.aborted) {
          call.state = 'aborted';
          toolResultParts.push(toolResult(call.id, call.name, 'aborted by user', true));
          continue;
        }
        // "Allow always": remember this tool so later calls skip the prompt.
        if (decision.approved && decision.always) sessionAllowedTools.add(call.name);
        if (!decision.approved) {
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
      if (out.media?.length) call.media = out.media;
      if (out.isError) call.error = out.text;
      recordEdits(opts.turnId, out.edits);
      emit();
      toolResultParts.push(toolResult(call.id, call.name, out.text, out.isError));
    }

    transcript.push({ role: 'tool', content: toolResultParts });
    if (opts.signal.aborted) return finish('completed', 'Stopped');
  }

  finish('completed', 'Stopped at the step limit — ask me to continue');
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
  // An early-end note (user Stop / step limit / dropped connection) shows as an
  // interrupt LABEL, not a fake assistant message in the transcript (v3 polish).
  state.endNote = note ?? null;
  state.status = status;
  state.error = error ?? null;
  state.pendingApproval = null;
  state.pendingQuestions = null;
  // Settle + drop any parked resolver so none leaks past the turn.
  approvalResolver?.({ approved: false, always: false });
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
  // Persist the conversation (best-effort) — each turn's end updates the same
  // session record. Emit AGAIN once it's on disk so the renderer refreshes its
  // sessions list only after the write lands; that fixes a list/write race that
  // kept a brand-new conversation out of the history until the next New chat.
  if (conversationId && state.messages.length > 0) {
    void persistSession()
      .then(() => emit())
      .catch(() => {});
  }
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
  // Respect the Data & Storage toggle: when session saving is off, conversations
  // stay in-memory only (no transcript written, nothing added to history).
  if (!getSettingsSync().storage.persistSessions) return;
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
    // Persist the provider-neutral transcript too, so a resumed session keeps
    // full context (display messages can't reconstruct tool_use/result pairing).
    transcript: [...transcript],
  };
  await saveSession(record);
}

/* ── public API (handlers.ts) ───────────────────────────────────────────── */

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
  const resolved = await resolveProviderAuth(provider);
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

/* ── compaction (claude-code / codex `/compact`) ────────────────────────── */

/** Flatten the running transcript to plain text for the summarization prompt. */
function serializeForCompaction(msgs: ModelMessage[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    let text: string;
    if (typeof m.content === 'string') {
      text = m.content;
    } else {
      // Each part is one of the AI SDK content shapes; we only need a textual
      // trace (prose + which tools ran), so read just these fields structurally.
      const parts = m.content as ReadonlyArray<{ type: string; text?: string; toolName?: string }>;
      const pieces: string[] = [];
      for (const p of parts) {
        if (p.type === 'text' && p.text) pieces.push(p.text);
        else if (p.type === 'tool-call' && p.toolName) pieces.push(`[ran ${p.toolName}]`);
        else if (p.type === 'tool-result' && p.toolName) pieces.push(`[result of ${p.toolName}]`);
        else if (p.type === 'image') pieces.push('[image]');
      }
      text = pieces.join(' ');
    }
    text = text.trim();
    if (text) lines.push(`${m.role}: ${text}`);
  }
  return lines.join('\n\n');
}

/**
 * Compact the conversation (claude-code / codex `/compact`): summarize the full
 * transcript with the conversation's own model, then replace the history with
 * that summary so later turns keep context without the token weight. Uses the
 * same provider-aware auth + system handling as a turn (anthropic-OAuth prefix,
 * codex `store:false`). Non-destructive (claude-code / cursor parity): only the
 * model-facing `transcript` is replaced by the summary (capped with a synthetic
 * assistant ack so the next turn still alternates user→assistant→user, an
 * Anthropic requirement). The user's visible scrollback (`state.messages`) is
 * KEPT — we just append a compaction divider that carries the summary — so the
 * conversation history never disappears from the UI, only from the context
 * window. An optional `focus` (from `/compact <focus>`) tells the summarizer
 * what to preserve in extra detail.
 */
export async function compactConversation(focus?: string): Promise<{ ok: boolean; reason?: string }> {
  if (busy() || starting) return { ok: false, reason: 'a turn is already in progress' };
  if (!conversationProvider || !conversationModel || !isProviderId(conversationProvider)) {
    return { ok: false, reason: 'nothing to compact yet' };
  }
  if (transcript.length < 2) return { ok: false, reason: 'conversation is too short to compact' };
  const provider = conversationProvider;
  const model = conversationModel;
  starting = true;
  try {
    const resolved = await resolveProviderAuth(provider);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const m = buildModel(provider, model, resolved.auth, resolved.baseUrl);
    const codexBackend = provider === 'openai-codex';
    const system =
      resolved.auth.mode === 'oauth' && provider === 'anthropic'
        ? CLAUDE_CODE_SYSTEM_PREFIX
        : undefined;
    const trimmedFocus = focus?.trim();
    const instruction = trimmedFocus
      ? `${COMPACT_INSTRUCTION}\n\nThe user asked you to preserve this in extra detail: ${trimmedFocus}`
      : COMPACT_INSTRUCTION;
    const convo = serializeForCompaction(transcript);
    const res = await generateText({
      model: m,
      system,
      prompt: `${instruction}\n\n<conversation>\n${convo}\n</conversation>`,
      maxOutputTokens: codexBackend ? undefined : 2048,
      providerOptions: codexBackend ? { openai: { store: false } } : undefined,
    });
    const summary = res.text.trim();
    if (!summary) return { ok: false, reason: 'the model returned an empty summary' };

    // Tokens currently in the context window — reported on the divider so the
    // user can see how much the compaction freed up.
    const freed = state.usage.inputTokens;
    transcript = [
      { role: 'user', content: `${SUMMARY_PREFIX}\n${summary}` },
      { role: 'assistant', content: 'Understood — I have the summary above and will continue from here.' },
    ];
    // Keep the visible scrollback intact; just mark where the model's memory was
    // condensed. The divider holds the summary so the user can expand it to see
    // exactly what the model will carry forward.
    state.messages.push({
      id: uid('m'),
      role: 'assistant',
      parts: [{ type: 'compaction', summary, freedTokens: freed > 0 ? freed : undefined }],
      timestamp: Date.now(),
    });
    state.usage = { inputTokens: 0, outputTokens: 0 };
    state.error = null;
    state.endNote = null;
    emit();
    if (conversationId) void persistSession().then(() => emit()).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: humanizeModelError(err, provider, model) };
  } finally {
    starting = false;
  }
}

export async function startTurn(input: AgentSendInput): Promise<AgentSendResult> {
  // `starting` closes the window between this check and `state.status` going
  // busy (there's an auth-resolution await before we set it), so two
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
    const resolved = await resolveProviderAuth(input.provider);
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
    state.activeSessionId = conversationId;
    controller = new AbortController();
    activeTabId = input.tabId;
    state.turnId = turnId;
    state.status = 'thinking';
    state.error = null;
    state.endNote = null;
    state.pendingApproval = null;
    state.pendingQuestions = null;

    const userText = buildUserText(input, ws);
    const images = input.images ?? [];
    const promptNote = input.captures.length > 0 ? `${input.prompt.trim()}\n\n(+${input.captures.length} attached capture${input.captures.length === 1 ? '' : 's'})` : input.prompt.trim();
    // Show the prompt text plus any pasted images as thumbnails in the transcript.
    const userParts: AgentMessage['parts'] = [{ type: 'text', text: promptNote }];
    for (const img of images) {
      userParts.push({ type: 'image', mediaType: img.mediaType, data: img.data });
    }
    state.messages.push({ id: uid('m'), role: 'user', parts: userParts, timestamp: Date.now() });
    // Forward images to the model as multimodal content parts alongside the text.
    if (images.length > 0) {
      transcript.push({
        role: 'user',
        content: [
          { type: 'text', text: userText },
          ...images.map((img) => ({
            type: 'image' as const,
            image: img.data,
            mediaType: img.mediaType,
          })),
        ],
      });
    } else {
      transcript.push({ role: 'user', content: userText });
    }
    emit();

    const settings = getSettingsSync();
    const agentSettings = settings.agent;
    // Reasoning effort only takes effect for models the catalog flags `reasoning`;
    // the builder ignores it otherwise (matched by provider + id, so a live-fetched
    // or remapped id still resolves through the same static catalog entry).
    const modelReasoning =
      MODELS.find((m) => m.provider === input.provider && m.id === input.model)?.reasoning ?? false;
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
      customInstructions: agentSettings.instructions,
      reasoningEffort: agentSettings.reasoningEffort,
      modelReasoning,
      fallbacks: agentSettings.fallback.enabled ? agentSettings.fallback.order : [],
      // Unattended only when the bridge is actually exposed AND skip is opted in;
      // turning the server off restores normal approval prompts automatically.
      unattended: settings.server.enabled && settings.server.skipApprovals,
    }).catch((err) => {
      // A user Stop surfaces here as an abort, not a real failure — label it
      // ('Stopped') rather than showing an error banner.
      if (controller?.signal.aborted || (err as Error)?.name === 'AbortError') {
        finish('completed', 'Stopped');
      } else {
        finish('failed', undefined, (err as Error).message);
      }
    });

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
  approvalResolver?.({ approved: false, always: false });
  answersResolver?.({});
  return true;
}

export function respond(turnId: string, callId: string, answers: AgentAnswers): boolean {
  if (state.pendingQuestions?.turnId !== turnId || state.pendingQuestions?.callId !== callId) return false;
  if (!answersResolver) return false;
  answersResolver(answers ?? {});
  return true;
}

export function approveTool(
  turnId: string,
  callId: string,
  approved: boolean,
  always = false,
): boolean {
  if (state.pendingApproval?.turnId !== turnId || state.pendingApproval?.callId !== callId) return false;
  if (!approvalResolver) return false;
  approvalResolver({ approved, always });
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
  // Forget tracked reads — the next conversation starts fresh, so a file read in
  // the prior chat shouldn't gate an edit here.
  clearReadTracker();
  // "Allow always" choices are conversation-scoped — drop them with the chat.
  sessionAllowedTools.clear();
  // The prior conversation was persisted on its last turn's finish(); drop its id
  // so the next turn begins (and saves to) a fresh session.
  conversationId = null;
  emit();
  return true;
}

/**
 * Load a saved session as the active conversation (v3 §5-C). Refuses while a turn
 * is in flight. The current conversation was already persisted on its last
 * finish(), so replacing state here loses nothing; unresolved (applied) edits are
 * kept exactly as reset() does, since those files are still modified on disk.
 * Restores the provider-neutral transcript when present (sessions saved before
 * that field resume as read-only history — messages render, but the model has no
 * prior context to continue from).
 */
export async function resumeSession(id: string): Promise<boolean> {
  if (busy()) return false;
  const record = await readSession(id);
  if (!record) return false;
  const keptEdits = state.edits.filter((e) => e.status === 'applied');
  sessionAllowedTools.clear();
  // Forget the prior conversation's tracked reads — same as reset(). A file read
  // in the chat we're leaving must not gate (or wrongly clear staleness on) an
  // edit in the resumed session.
  clearReadTracker();
  state = emptyAgentChatState();
  state.edits = keptEdits;
  state.messages = record.messages ?? [];
  state.usage = record.usage ? { ...record.usage } : { inputTokens: 0, outputTokens: 0 };
  transcript = record.transcript ? [...record.transcript] : [];
  conversationId = record.id;
  conversationStartedAt = record.createdAt;
  conversationTitle = record.title;
  conversationProvider = record.provider;
  conversationModel = record.model;
  state.activeSessionId = conversationId;
  emit();
  return true;
}

/** Saved sessions, newest first (summaries only) — backs the sessions UI list. */
export function listSavedSessions(): Promise<SessionSummary[]> {
  return listSessions();
}

/**
 * Delete a saved session. When it's the live conversation, clear the chat first
 * so the next turn starts fresh; refuses if that conversation is mid-turn.
 */
export async function deleteSavedSession(id: string): Promise<boolean> {
  if (conversationId === id) {
    if (busy()) return false;
    reset();
  }
  return deleteSession(id);
}
