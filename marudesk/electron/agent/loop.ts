import type {
  AgentAnswers,
  AgentChatState,
  AgentMessage,
  AgentReasoningPart,
  AgentSendInput,
  AgentSendResult,
  AgentTextPart,
  ToolCall,
} from '../../shared/agent';
import type { AppliedChange } from '../../shared/patch';
import type { WorkspaceSummary } from '../../shared/workspace';
import { MODELS } from '../../shared/providers';
import { CLAUDE_CODE_SYSTEM_PREFIX } from '../oauth/config';
import { getSettingsSync, patchSettings } from '../settings';
import type { AgentApprovalMode, ModelRef, ReasoningEffort } from '../../shared/settings';
import { requireWorkspace } from '../ipc/define-handler';
import { effectiveAgentRoot } from '../worktree-isolation';
import { setNetworkCapture } from '../browser/state';
import { streamText } from 'ai';
import { buildModel, aiTools, humanizeModelError, isFailoverError, type ModelAuth } from './model';
import { loadGlobalUserInstructions, loadWorkspaceInstructions } from './instructions';
import { claimNestedInstructions } from './nested-instructions';
import { buildEnvironmentContext } from './environment';
import {
  ASK_USER,
  SPAWN_SUBAGENT,
  SPAWN_BACKGROUND_AGENT,
  COLLECT_BACKGROUND_AGENT,
  CANCEL_BACKGROUND_AGENT,
  UPDATE_PLAN,
  describeToolInput,
  type ToolContext,
  type ToolResult,
} from './tools';
import {
  SYSTEM_PROMPT,
  PLAN_MODE_SYSTEM,
  SAFETY_FOOTER,
  approvalModeContext,
  modelGuidance,
} from './prompts.ts';
import { callMcpTool, isGatedTool, isWriteTool, listMcpTools } from './mcp';
import { isModeClear, modePreamble, modeRaisesThinking, modesInPrompt } from './keyword-modes';
import { buildProviderOptions, maxTokensForTurn } from './reasoning-config';
import { resolveProviderAuth } from './resolve-auth';
import { runSubagentTool } from './subagent';
import { updatePlanTool } from './plan';
import {
  startBackgroundAgentTool,
  collectBackgroundTool,
  cancelBackgroundTool,
} from './background';
import { runContextHook, runVerifyNote } from './loop-commands.ts';
import {
  emitContainer,
  currentContainer,
  containerBusy,
  uid,
  type ApprovalDecision,
  type ThreadContainer,
} from './loop-state.ts';
export { subscribeAgentEvents } from './loop-state.ts';
export {
  listThreads,
  newThread,
  switchThread,
  closeThread,
  activeThreadId,
} from './loop-state.ts';
import { persistSession } from './loop-sessions.ts';
export { reset, resumeSession, listSavedSessions, deleteSavedSession } from './loop-sessions.ts';
import { compactConversation } from './loop-compaction.ts';
export { compactConversation } from './loop-compaction.ts';
export {
  abortTurn,
  respond,
  approveTool,
  acceptEdit,
  revertEdit,
  snapshot,
  setApprovalMode,
} from './loop-turn-actions.ts';
export { editPlanStep } from './plan.ts';
import {
  buildUserText,
  toolResult,
  type ToolResultPartLite,
} from './loop-helpers.ts';
export { testProviderConnection } from './loop-helpers.ts';

/**
 * The manual step-driven agent loop (docs/agentic-chat-design.md §5). main owns
 * the authoritative {@link AgentChatState}; each step is one driver round-trip,
 * after which we execute the model's tool calls (parking on approval/ask_user),
 * append results, and re-enter. Each turn runs on ITS thread container (Stage
 * 12-B-2), captured at startTurn, so several threads can run concurrently without
 * clobbering each other; the ACTIVE thread streams to the renderer as a coalesced
 * `agent:event` snapshot, a background thread only refreshes its switcher summary.
 */

const MAX_STEPS = 24;

/**
 * Wall-clock backstop for a single tool call (audit H4). Generous enough to not
 * cut off a legitimate slow tool or a multi-step subagent, but bounds a tool
 * that hangs and ignores the abort signal so it can't wedge the turn forever.
 */
const TOOL_WALL_CLOCK_MS = 15 * 60_000;

/**
 * Fraction of the conversation (by character weight) kept VERBATIM as the tail
 * when compacting. Only the older head is summarized; recent turns survive intact
 * so the model keeps full fidelity on what it's actively working on (cursor /
 * copilot "extract + tail preservation"). The tail is snapped to a turn (user
 * message) boundary so the rebuilt S.transcript stays valid.
 */


/* ── message helpers ────────────────────────────────────────────────────── */

/** One tool result for the S.transcript (AI SDK tool-message content shape). */


function recordEdits(S: ThreadContainer, turnId: string, changes: AppliedChange[] | undefined): void {
  if (!changes) return;
  for (const c of changes) {
    S.state.edits.push({
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

/* ── parking (approval / ask_user) ──────────────────────────────────────── */

// Settle-then-replace: never leave a live resolver from a prior call behind, so
// a late agent:approve-tool / agent:respond can't resolve the wrong parked
// promise. The turnId+callId guards in approveTool/respond are the primary gate;
// this is belt-and-suspenders for the resolver lifecycle.
function waitForApproval(S: ThreadContainer): Promise<ApprovalDecision> {
  S.approvalResolver?.({ approved: false, always: false });
  return new Promise((resolve) => {
    S.approvalResolver = resolve;
  });
}

function waitForAnswers(S: ThreadContainer): Promise<AgentAnswers> {
  S.answersResolver?.({});
  return new Promise((resolve) => {
    S.answersResolver = resolve;
  });
}

/* ── the loop ───────────────────────────────────────────────────────────── */

type RunOpts = {
  auth: ModelAuth;
  /** The thread container this turn runs on (Stage 12-B-2 concurrent execution). */
  container: ThreadContainer;
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
  // Stage 12-B-2 concurrent execution: this turn runs on ITS captured thread
  // container, not the globally-active one. Shadowing `S` + `emit` here routes
  // every `S.x` / `emit()` in the body to this thread, so two turns can run at
  // once without clobbering each other (and a non-active turn refreshes only its
  // switcher summary). For a single thread this container IS the active one, so
  // the behavior is identical to before.
  const S = opts.container;
  const emit = (): void => emitContainer(S);
  const ctx: ToolContext = {
    ws: opts.ws,
    tabId: opts.tabId,
    signal: opts.signal,
    denyGlobs: opts.denyGlobs,
    provider: opts.provider,
    model: opts.model,
    thread: S,
  };
  const tools = aiTools(listMcpTools());
  // Fold instruction files + runtime grounding into the system prompt (Track B
  // §B2; Claude Code / Codex parity). Independent reads run in parallel:
  //  - repo conventions (AGENTS.md / CLAUDE.md + CLAUDE.local.md, @imports expanded)
  //  - the user's GLOBAL standing instructions (~/.claude, ~/.codex)
  //  - the runtime/environment block (date, OS, workspace, git state)
  const [wsInstructions, globalUserInstructions, envContext] = await Promise.all([
    loadWorkspaceInstructions(opts.ws),
    loadGlobalUserInstructions(),
    buildEnvironmentContext(opts.ws),
  ]);
  // The current approval constraints, so the model knows what it may do (Codex
  // environment-context parity). Plan mode uses its own addendum below.
  const modeContext = approvalModeContext(opts.approvalMode);

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
    // Trust ordering (review: trust-boundary): base rules first, then our own
    // trusted runtime grounding (environment + approval mode), then the repo's
    // conventions, then the USER's own standing instructions — global then
    // per-app — (user > repo), then the active-mode constraint, and finally
    // re-pin our precedence as the last word. The footer is added only when some
    // instruction file / standing instruction is actually folded in, so it costs
    // nothing on a plain conversation.
    const hasFoldedInstructions = !!(
      wsInstructions.trim() ||
      globalUserInstructions.trim() ||
      opts.customInstructions.trim()
    );
    const trustFooter = hasFoldedInstructions ? SAFETY_FOOTER : null;
    const system = [
      baseSystem,
      modelGuidance(a.provider, a.modelId, a.modelReasoning),
      envContext,
      modeContext,
      wsInstructions,
      globalUserInstructions,
      opts.customInstructions,
      planAddendum,
      trustFooter,
    ]
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

  // Recovery bookkeeping (v5 §G4): consecutive failures per tool name within this
  // turn, reset on that tool's next success. When a tool keeps failing we append a
  // recovery hint to its model-facing result so the agent stops blindly repeating
  // the same call and instead re-reads state, changes approach, or asks the user.
  const toolFailures = new Map<string, number>();
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
    if (opts.signal.aborted) return finish(S, 'completed', 'Stopped');
    S.state.status = 'thinking';

    // Create the assistant message up front so streamed text deltas render live
    // (real token streaming); tool calls are attached once the step settles.
    const assistantMsg: AgentMessage = {
      id: uid('m'),
      turnId: opts.turnId,
      role: 'assistant',
      parts: [{ type: 'text', text: '' }],
      timestamp: Date.now(),
    };
    const textPart = assistantMsg.parts[0] as AgentTextPart;
    S.state.messages.push(assistantMsg);
    emit();

    // Reasoning ("extended thinking") streams on a separate channel; render it as
    // a collapsible block ABOVE the answer (v3 §5-A). Created lazily on the first
    // delta and kept display-only (never pushed into the provider S.transcript).
    let reasoningPart: AgentReasoningPart | null = null;

    let toolUses: { id: string; name: string; input: unknown }[];
    try {
      const res = streamText({
        model: current.model,
        // codex carries the system prompt in providerOptions.openai.instructions
        // (see above), so don't also pass it here or it lands twice.
        system: current.codexBackend ? undefined : current.system,
        messages: S.transcript,
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
      S.state.usage.inputTokens += usage.inputTokens ?? 0;
      S.state.usage.outputTokens += usage.outputTokens ?? 0;
      // The latest call's input size is the live context-window occupancy (the
      // whole S.transcript is re-sent each step), so overwrite rather than sum —
      // this drives the usage gauge and the auto-compaction threshold.
      if (usage.inputTokens) S.state.usage.contextTokens = usage.inputTokens;
    } catch (err) {
      // Drop the optimistic streaming bubble if nothing was streamed into it, so
      // a failed/aborted step doesn't leave an empty assistant message behind.
      // Reasoning-only content still counts — keep a thinking-only bubble.
      if (!textPart.text.trim() && !reasoningPart?.text.trim()) {
        const i = S.state.messages.indexOf(assistantMsg);
        if (i !== -1) S.state.messages.splice(i, 1);
      }
      if (opts.signal.aborted) return finish(S, 'completed', 'Stopped');
      // Provider exhausted (429) or a transient server error (5xx): fall over to
      // the next configured model and retry THIS step. The S.transcript is
      // provider-neutral, so only the per-provider scaffolding swaps; once we
      // switch, the rest of the turn stays on the new model.
      if (isFailoverError(err)) {
        const next = await pickNextFallback();
        if (next) {
          // Discard any partial bubble from the failed attempt; the retry makes a
          // fresh one. (429 usually fires before any text streams.)
          const i = S.state.messages.indexOf(assistantMsg);
          if (i !== -1) S.state.messages.splice(i, 1);
          current = next;
          emit();
          step--; // re-run this step index on the new model
          continue;
        }
      }
      return finish(
        S,
        'failed',
        undefined,
        humanizeModelError(err, current.provider, current.modelId),
      );
    }

    // Attach tool-call cards to the streamed message + mirror the turn into the
    // S.transcript (a valid tool_use the next step answers with a tool_result).
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
    S.transcript.push({ role: 'assistant', content: assistantContent });
    emit();

    if (calls.length === 0) {
      // Post-edit verify hook: if this turn changed files and a verify command is
      // configured, run it and fold the result into this assistant message (UI +
      // model context) before completing.
      const note = await runVerifyNote(S, opts.turnId, opts.ws);
      if (note) {
        assistantMsg.parts.push({ type: 'text', text: note });
        assistantContent.push({ type: 'text', text: note });
        emit();
      }
      return finish(S, 'completed');
    }

    // Execute each tool call; collect one tool_result per call (S.transcript stays valid).
    S.state.status = 'working';
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
        const answered = await handleAskUser(S, opts.turnId, call, opts.signal);
        toolResultParts.push(toolResult(call.id, call.name, answered.content, answered.isError));
        continue;
      }

      // Per-tool deny list (v6 §W7): a tool the user banned is blocked in EVERY
      // mode (even auto) — the tool-level twin of denyGlobs. Checked before any
      // approval path so it can't be auto-approved or "allow always"-ed.
      if (getSettingsSync().agent.denyTools.includes(call.name)) {
        call.state = 'denied';
        call.resultText = 'Blocked: deny list.';
        emit();
        toolResultParts.push(
          toolResult(
            call.id,
            call.name,
            `Blocked: "${call.name}" is on the user's tool deny list (Settings → Agent). Use a different approach.`,
            true,
          ),
        );
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
      //
      // Edit preview (§G1): when the user set editApproval='preview', also park
      // file edits (edit_file/multi_edit) in Ask mode so they can confirm the
      // proposed diff BEFORE it's written. read-only/plan already blocked above;
      // Auto and unattended keep applying straight through (no one to confirm).
      const editPreview =
        !opts.unattended &&
        opts.approvalMode === 'ask' &&
        getSettingsSync().agent.editApproval === 'preview' &&
        isWriteTool(call.name) &&
        !isGatedTool(call.name);
      const gatedApproval =
        isGatedTool(call.name) && opts.approvalMode !== 'auto' && !opts.unattended;
      // "Allow always" is honored from both this conversation's in-memory set and
      // the persisted cross-session list (v6 §W7/U10).
      const preApproved =
        S.sessionAllowedTools.has(call.name) ||
        getSettingsSync().agent.alwaysAllowTools.includes(call.name);
      if ((gatedApproval || editPreview) && !preApproved) {
        call.state = 'awaiting_approval';
        S.state.status = 'waiting_for_user';
        S.state.pendingApproval = {
          turnId: opts.turnId,
          callId: call.id,
          name: call.name,
          detail: describeToolInput(call.name, call.input),
          ...(editPreview ? { diffs: editDiffs(call.input) } : {}),
        };
        emit();
        const decision = await waitForApproval(S);
        S.approvalResolver = null;
        S.state.pendingApproval = null;
        if (opts.signal.aborted) {
          call.state = 'aborted';
          toolResultParts.push(toolResult(call.id, call.name, 'aborted by user', true));
          continue;
        }
        // "Allow always": skip the prompt for later calls — this conversation
        // (in-memory) AND future ones (persisted, v6 §W7/U10; revocable in
        // Settings → Agent). Editor-preview parks aren't gated tools, so persist
        // only genuine gated tools.
        if (decision.approved && decision.always) {
          S.sessionAllowedTools.add(call.name);
          if (isGatedTool(call.name)) {
            const cur = getSettingsSync().agent.alwaysAllowTools;
            if (!cur.includes(call.name)) {
              void patchSettings({ agent: { alwaysAllowTools: [...cur, call.name] } });
            }
          }
        }
        if (!decision.approved) {
          call.state = 'denied';
          call.resultText = 'Denied by the user.';
          S.state.status = 'working';
          emit();
          toolResultParts.push(toolResult(call.id, call.name, 'The user denied this tool call.', true));
          continue;
        }
        S.state.status = 'working';
        emit();
      }

      call.state = 'running';
      if (call.name === SPAWN_SUBAGENT || call.name === SPAWN_BACKGROUND_AGENT) {
        call.summary = describeToolInput(call.name, call.input);
      }
      emit();
      // W4/U3: a foreground subagent blocks this turn, so stream its partial text +
      // tool trace onto THIS running card (the child mutates `call` via the sink and
      // re-emits). Other tools dispatch with the plain ctx. Cleared on settle.
      const dispatchCtx: ToolContext =
        call.name === SPAWN_SUBAGENT
          ? {
              ...ctx,
              onSubagentProgress: ({ text, traces }) => {
                call.streamedText = text;
                call.streamedTraces = [...traces];
                emit();
              },
            }
          : ctx;
      const out = await dispatchToolBounded(call.name, call.input, dispatchCtx);
      // The final result card supersedes the live stream — drop the partials.
      call.streamedText = undefined;
      call.streamedTraces = undefined;
      call.state = out.isError ? 'error' : 'ok';
      call.summary = out.summary;
      call.resultText = out.text;
      if (out.media?.length) call.media = out.media;
      if (out.artifact) call.artifact = out.artifact;
      if (out.isError) call.error = out.text;
      recordEdits(S, opts.turnId, out.edits);
      emit();
      // Lazily inject not-yet-seen per-directory instruction files for any path
      // this tool entered (§B2 on-demand). Appended to the MODEL-facing result
      // only — the UI card (call.resultText) stays focused on the tool output.
      let modelText = out.text;
      // Recovery hint (§G4): track consecutive per-tool failures and nudge the
      // agent out of a retry loop. Appended to the model-facing text only.
      if (out.isError) {
        const n = (toolFailures.get(call.name) ?? 0) + 1;
        toolFailures.set(call.name, n);
        const hint = recoveryHint(call.name, n);
        if (hint) modelText = `${modelText}\n\n${hint}`;
      } else {
        toolFailures.delete(call.name);
      }
      if (!out.isError && opts.ws && out.touchedPaths?.length) {
        const reminders: string[] = [];
        for (const rel of out.touchedPaths) {
          const block = await claimNestedInstructions(opts.ws.root, rel);
          if (block) reminders.push(block);
        }
        if (reminders.length > 0) modelText = `${out.text}\n\n${reminders.join('\n\n')}`;
      }
      toolResultParts.push(toolResult(call.id, call.name, modelText, out.isError));
    }

    S.transcript.push({ role: 'tool', content: toolResultParts });
    if (opts.signal.aborted) return finish(S, 'completed', 'Stopped');
  }

  finish(S, 'completed', 'Stopped at the step limit — ask me to continue');
}

/**
 * Route a tool call. Most tools go through the MCP registry; the agent meta-tools
 * are loop-intercepted so they can reach the child runtime: spawn_subagent blocks
 * for the child report, while the background trio manage detached agents
 * (spawn returns immediately; collect/cancel are synchronous registry calls).
 */
async function dispatchTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (name === SPAWN_SUBAGENT) return runSubagentTool(input, ctx);
  if (name === SPAWN_BACKGROUND_AGENT) return startBackgroundAgentTool(input, ctx);
  if (name === COLLECT_BACKGROUND_AGENT) return collectBackgroundTool(input, ctx);
  if (name === CANCEL_BACKGROUND_AGENT) return cancelBackgroundTool(input, ctx);
  if (name === UPDATE_PLAN) return updatePlanTool(input, ctx);
  return callMcpTool(name, input, ctx);
}

/**
 * Wall-clock + abort backstop around {@link dispatchTool} (audit H4). Almost
 * every tool honors `ctx.signal` (run_command kills its child, streamText
 * cancels), but a misbehaving one — a custom/external MCP tool, a subagent that
 * ignores the signal — could otherwise run past a user Stop and wedge the turn,
 * since the loop only re-checks `signal.aborted` AFTER the await returns. We race
 * the dispatch against the abort signal and a generous wall-clock so the loop
 * always regains control: the abandoned operation may keep running detached, but
 * its result is discarded and the loop's post-tool abort check ends the turn.
 */
async function dispatchToolBounded(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.signal.aborted) return { summary: 'aborted', text: `${name} aborted`, isError: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      dispatchTool(name, input, ctx),
      new Promise<ToolResult>((resolve) => {
        onAbort = () => resolve({ summary: 'aborted', text: `${name} aborted`, isError: true });
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }),
      new Promise<ToolResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              summary: 'timed out',
              text: `${name} exceeded the ${Math.round(TOOL_WALL_CLOCK_MS / 60_000)}-minute tool time limit and was abandoned`,
              isError: true,
            }),
          TOOL_WALL_CLOCK_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Recovery nudge for a tool that keeps failing in the same turn (§G4). Escalates:
 * a 2nd consecutive failure says "stop repeating, re-read / change approach"; a
 * 3rd+ says "this approach is stuck — solve it differently or ask the user".
 * Returns null on the first failure (a single error needs no nudge).
 */
function recoveryHint(name: string, consecutiveFailures: number): string | null {
  if (consecutiveFailures <= 1) return null;
  if (consecutiveFailures === 2) {
    return `[recovery] ${name} has now failed twice in a row. Do not repeat the same call — re-read the relevant file/state (it may have changed) or take a different approach.`;
  }
  return `[recovery] ${name} has failed ${consecutiveFailures} times in a row. Stop retrying this approach: either solve the problem a fundamentally different way, or call ask_user to get the user's help instead of guessing.`;
}

/**
 * Derive the proposed per-op diffs from an edit_file/multi_edit call input, for
 * the §G1 preview approval card. before = oldString, after = newString (the
 * change the agent is about to write); nothing is read from disk here.
 */
function editDiffs(input: unknown): { path: string; before: string; after: string }[] {
  const o = (input ?? {}) as Record<string, unknown>;
  const ops = Array.isArray(o.edits) ? o.edits : [o];
  return ops.flatMap((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.path !== 'string') return [];
    return [
      {
        path: r.path,
        before: typeof r.oldString === 'string' ? r.oldString : '',
        after: typeof r.newString === 'string' ? r.newString : '',
      },
    ];
  });
}

async function handleAskUser(
  S: ThreadContainer,
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
  S.state.status = 'waiting_for_user';
  S.state.pendingQuestions = { turnId, callId: call.id, questions };
  emitContainer(S);
  const answers = await waitForAnswers(S);
  S.answersResolver = null;
  S.state.pendingQuestions = null;
  // Aborted while parked: record the call as aborted, not answered, so a resumed
  // conversation's S.transcript doesn't carry a fabricated "answer".
  if (signal.aborted) {
    call.state = 'aborted';
    return { content: 'aborted by user', isError: true };
  }
  call.state = 'ok';
  S.state.status = 'working';
  emitContainer(S);
  const text = questions
    .map((q) => `Q: ${q.question}\nA: ${answers[q.id] ?? '(no answer)'}`)
    .join('\n\n');
  return { content: text || 'The user provided no answers.' };
}

function finish(S: ThreadContainer, status: AgentChatState['status'], note?: string, error?: string): void {
  // An early-end note (user Stop / step limit / dropped connection) shows as an
  // interrupt LABEL, not a fake assistant message in the S.transcript (v3 polish).
  S.state.endNote = note ?? null;
  S.state.status = status;
  S.state.error = error ?? null;
  S.state.pendingApproval = null;
  S.state.pendingQuestions = null;
  // Settle + drop any parked resolver so none leaks past the turn.
  S.approvalResolver?.({ approved: false, always: false });
  S.approvalResolver = null;
  S.answersResolver?.({});
  S.answersResolver = null;
  // Stop the lazy network capture this turn may have enabled — otherwise the
  // relay keeps buffering responses for the tab forever (the always-on path is
  // meant to stay Runtime-only when no agent turn is active).
  if (S.activeTabId) {
    setNetworkCapture(S.activeTabId, false);
    S.activeTabId = undefined;
  }
  S.controller = null;
  emitContainer(S);
  // Persist the conversation (best-effort) — each turn's end updates the same
  // session record. Emit AGAIN once it's on disk so the renderer refreshes its
  // sessions list only after the write lands; that fixes a list/write race that
  // kept a brand-new conversation out of the history until the next New chat.
  if (S.conversationId && S.state.messages.length > 0) {
    void persistSession(S)
      .then(() => emitContainer(S))
      .catch(() => {});
  }
  // Auto-compaction (claude-code / cursor parity): once a turn completes cleanly,
  // compact in the background if the context has grown past the configured
  // threshold. Skipped on interrupts and failures (those carry a note/error) so
  // we never compact a half-finished turn.
  if (status === 'completed' && note === undefined && error === undefined && shouldAutoCompact(S)) {
    void compactConversation(undefined, S).catch(() => {});
  }
}

/** True when auto-compaction is enabled and the live context is over threshold. */
function shouldAutoCompact(S: ThreadContainer): boolean {
  const cfg = getSettingsSync().agent.autoCompact;
  if (!cfg.enabled) return false;
  const ctx = S.state.usage.contextTokens;
  if (ctx <= 0) return false;
  const window = MODELS.find(
    (mm) => mm.provider === S.conversationProvider && mm.id === S.conversationModel,
  )?.contextWindow;
  if (!window) return false;
  return ctx / window >= cfg.threshold;
}


/* ── public API (handlers.ts) ───────────────────────────────────────────── */

/**
 * A minimal live request to verify a provider's credentials work — for the
 * Settings "Test connection" button. Especially useful for OAuth providers,
 * which have no /models endpoint to probe (so the model-list path can't tell a
 * dead token from a working one). Resolves auth exactly like a turn, then runs a
 * tiny generateText against the provider's default model.
 */
export async function startTurn(input: AgentSendInput): Promise<AgentSendResult> {
  // Bind this turn to the ACTIVE thread's container now (Stage 12-B-2). Capturing
  // it up front means the turn sets up + runs on the thread the user sent to even
  // if they switch away during the async auth resolve below. `busy()` checks the
  // active thread — a turn already running on ANOTHER thread doesn't block this.
  const S = currentContainer();
  // `S.starting` closes the window between this check and `S.state.status` going
  // busy (there's an auth-resolution await before we set it), so two
  // near-simultaneous sends can't both set up a turn and clobber `S.controller`.
  if (containerBusy(S) || S.starting) return { ok: false, reason: 'a turn is already in progress' };
  S.starting = true;
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
      // Worktree isolation (Stage 12-B): when active for this repo, the agent
      // operates on the isolated worktree — its file edits, run_command, and
      // diagnostics all run there. Off ⇒ effectiveAgentRoot returns the same
      // root, so this is a no-op. The editor/UI keep the main root.
      const eff = effectiveAgentRoot(ws.root);
      if (eff !== ws.root) ws = { ...ws, root: eff };
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
    if (!S.conversationId) {
      S.conversationId = uid('session');
      S.conversationStartedAt = Date.now();
      S.conversationTitle = input.prompt.trim().split('\n')[0].slice(0, 60) || 'Untitled chat';
    }
    S.conversationProvider = input.provider;
    S.conversationModel = input.model;
    S.state.activeSessionId = S.conversationId;
    S.controller = new AbortController();
    S.activeTabId = input.tabId;
    S.state.turnId = turnId;
    S.state.status = 'thinking';
    S.state.error = null;
    S.state.endNote = null;
    S.state.pendingApproval = null;
    S.state.pendingQuestions = null;

    // Resolve sticky keyword modes for this turn: an explicit "mode off" clears
    // the set; otherwise any mode keyword in the message is added to the active
    // set, which persists across turns. The preamble for the full active set is
    // folded into the model-facing text below.
    if (isModeClear(input.prompt)) {
      S.activeModes = [];
    } else {
      const added = modesInPrompt(input.prompt);
      if (added.length > 0) S.activeModes = [...new Set([...S.activeModes, ...added])];
    }
    const modePreambleText = modePreamble(S.activeModes);
    const userText = buildUserText(input, ws, modePreambleText);
    const images = input.images ?? [];
    const promptNote = input.captures.length > 0 ? `${input.prompt.trim()}\n\n(+${input.captures.length} attached capture${input.captures.length === 1 ? '' : 's'})` : input.prompt.trim();
    // Show the prompt text plus any pasted images as thumbnails in the S.transcript.
    const userParts: AgentMessage['parts'] = [{ type: 'text', text: promptNote }];
    for (const img of images) {
      userParts.push({ type: 'image', mediaType: img.mediaType, data: img.data });
    }
    S.state.messages.push({
      id: uid('m'),
      turnId,
      role: 'user',
      parts: userParts,
      timestamp: Date.now(),
    });
    // Show the user's message immediately, before the (possibly slow) context
    // hook runs below.
    emitContainer(S);
    // Per-turn context hook (UserPromptSubmit parity): run the user's command and
    // fold its output into the MODEL-facing text only — the chat keeps showing the
    // original message. Best-effort; default off (no-op when unset).
    const contextBlock = await runContextHook(ws);
    const modelText = contextBlock ? `${userText}\n\n${contextBlock}` : userText;
    // Forward images to the model as multimodal content parts alongside the text.
    if (images.length > 0) {
      S.transcript.push({
        role: 'user',
        content: [
          { type: 'text', text: modelText },
          ...images.map((img) => ({
            type: 'image' as const,
            image: img.data,
            mediaType: img.mediaType,
          })),
        ],
      });
    } else {
      S.transcript.push({ role: 'user', content: modelText });
    }

    const settings = getSettingsSync();
    const agentSettings = settings.agent;
    // Reasoning effort only takes effect for models the catalog flags `reasoning`;
    // the builder ignores it otherwise (matched by provider + id, so a live-fetched
    // or remapped id still resolves through the same static catalog entry).
    const modelReasoning =
      MODELS.find((m) => m.provider === input.provider && m.id === input.model)?.reasoning ?? false;
    // Deep-thinking mode active (think/ultrathink, sticky): raise this turn's
    // reasoning effort to the max for a reasoning model. Never lowers the
    // configured effort and is a no-op for non-reasoning models.
    const reasoningEffort =
      modelReasoning && modeRaisesThinking(S.activeModes) ? 'high' : agentSettings.reasoningEffort;
    void runLoop({
      auth,
      container: S,
      baseUrl,
      model: input.model,
      provider: input.provider,
      ws,
      tabId: input.tabId,
      turnId,
      signal: S.controller.signal,
      approvalMode: agentSettings.approvalMode,
      denyGlobs: agentSettings.denyGlobs,
      customInstructions: agentSettings.instructions,
      reasoningEffort,
      modelReasoning,
      fallbacks: agentSettings.fallback.enabled ? agentSettings.fallback.order : [],
      // Unattended only when the bridge is actually exposed AND skip is opted in;
      // turning the server off restores normal approval prompts automatically.
      unattended: settings.server.enabled && settings.server.skipApprovals,
    }).catch((err) => {
      // A user Stop surfaces here as an abort, not a real failure — label it
      // ('Stopped') rather than showing an error banner.
      if (S.controller?.signal.aborted || (err as Error)?.name === 'AbortError') {
        finish(S, 'completed', 'Stopped');
      } else {
        finish(S, 'failed', undefined, (err as Error).message);
      }
    });

    return { ok: true, turnId };
  } finally {
    // By here the turn is set up (status busy) or we returned an error; either
    // way subsequent sends are gated by busy(), so releasing `S.starting` is safe.
    S.starting = false;
  }
}

