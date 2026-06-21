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
import type { WorkspaceSummary, WorkspaceId } from '../../shared/workspace';
import { MODELS, isProviderId, type ProviderId } from '../../shared/providers';
import { resolveModelEntry } from '../../shared/model-normalize';
import { scrubText } from '../../shared/scrub';
import { CLAUDE_CODE_SYSTEM_PREFIX } from '../oauth/config';
import { getSettingsSync, patchSettings } from '../settings';
import type { AgentApprovalMode, ModelRef, ReasoningEffort } from '../../shared/settings';
import { requireWorkspace } from '../ipc/define-handler';
import { effectiveAgentRoot } from '../worktree-isolation';
import { setNetworkCapture } from '../browser/state';
import { streamText } from 'ai';
import {
  buildModel,
  aiTools,
  cachedSystem,
  withMessagePrefixCache,
  cacheReadTokensOf,
  humanizeModelError,
  type ModelAuth,
} from './model';
import { classifyStreamError, backoffDelayMs } from './stream-error.ts';
import {
  emptyLoopDetectorState,
  recordToolCall as recordLoopDetectorCall,
  loopDetectorNudge,
  recordFailureWindow,
  windowedFailureCount,
  recoveryHint,
  pickStepNudge,
  type LoopDetectorState,
} from './loop-detector.ts';
import {
  emptyDelegationReminderState,
  recordDelegationCall,
  delegationReminderNudge,
  type DelegationReminderState,
} from './delegation-reminder.ts';
import { dedupInstructionSources, loadGlobalUserInstructions, loadWorkspaceInstructions } from './instructions';
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
  previewGatedAction,
  clearActionPreview,
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
import { callMcpTool, getMcpToolDef, isGatedTool, isWriteTool, listMcpTools } from './mcp';
import { isSharedTool } from './tool-concurrency.ts';
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
import { runBeforeTurnContributors } from './before-turn.ts';
export { registerBeforeTurnContributor } from './before-turn.ts';
import { runBeforeToolCall, runAfterToolCall } from './tool-intercept.ts';
export {
  registerBeforeToolCall,
  registerAfterToolCall,
} from './tool-intercept.ts';
import {
  emitContainer,
  currentContainer,
  containerForWorkspace,
  containerForThread,
  containerBusy,
  uid,
  type ApprovalDecision,
  type ThreadContainer,
} from './loop-state.ts';
import { getWorkspaceSummary } from '../workspace-registry';
export { subscribeAgentEvents, subscribeWorkspaceAgentEvents } from './loop-state.ts';
export {
  listThreads,
  newThread,
  switchThread,
  closeThread,
  activeThreadId,
  runtimeSnapshot,
} from './loop-state.ts';
import { notifySessionStart, persistSession, reset as resetConversation } from './loop-sessions.ts';
export { reset, resumeSession, listSavedSessions, deleteSavedSession } from './loop-sessions.ts';
import { generateHandoff, buildHandoffSeed, type HandoffResult } from './handoff.ts';
export type { HandoffResult } from './handoff.ts';
import { TtsrManager } from './ttsr-manager.ts';
import { compactConversation } from './loop-compaction.ts';
export { compactConversation } from './loop-compaction.ts';
import {
  messageChars,
  emergencyCompactionReason,
  advanceDegradationMonitor,
  capToolOutput,
} from './compaction-utils.ts';
export {
  abortTurn,
  respond,
  approveTool,
  acceptEdit,
  revertEdit,
  restoreTurnPage,
  restoreTurnCheckpoint,
  snapshot,
  setApprovalMode,
  setReasoningEffort,
} from './loop-turn-actions.ts';
import { recordTurnStartUrl, recordTurnCheckpoint } from './loop-turn-actions.ts';
export { editPlanStep } from './plan.ts';
import {
  buildUserText,
  toolResult,
  type ToolResultPartLite,
} from './loop-helpers.ts';
import { MAX_TURN_STEPS, stepLimitNote, appendNoteToLastToolResult } from './turn-limits.ts';
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

/**
 * Wall-clock backstop for a single tool call (audit H4). Generous enough to not
 * cut off a legitimate slow tool or a multi-step subagent, but bounds a tool
 * that hangs and ignores the abort signal so it can't wedge the turn forever.
 */
const TOOL_WALL_CLOCK_MS = 15 * 60_000;

/**
 * How many foreground subagents from one fan-out run execute at the same time.
 * A run larger than this proceeds in chunks, so a 10-way spawn can't hammer the
 * provider with 10 concurrent streams (mirrors MAX_ACTIVE_BACKGROUND's intent).
 */
const MAX_PARALLEL_SUBAGENTS = 4;

/**
 * How many consecutive `shared` (read-only) tool calls from one model step run
 * concurrently. A run larger than this proceeds in chunks. Bounds parallel fs /
 * search load while still turning a multi-read survey from a sum of latencies into
 * (roughly) a max. Mirrors MAX_PARALLEL_SUBAGENTS' chunking intent.
 */
const MAX_PARALLEL_SHARED_TOOLS = 4;

/**
 * Max same-provider transient retries (429/overload/5xx/network) per turn before
 * we give up retrying THIS provider and fall over to the next configured model
 * (item 1). With exponential backoff (1s, 2s, 4s, 8s) this rides out a brief
 * provider blip — crucially for a single-provider user (Anthropic OAuth, no
 * fallback) who would otherwise hard-fail on the first 429.
 */
const MAX_STREAM_RETRIES = 4;

/**
 * Max context-overflow → compaction → retry cycles per turn (item 2). One pass
 * normally clears the overflow; the cap stops an un-shrinkable transcript (a
 * single huge tool result) from compacting forever. When spent we fall over /
 * surface instead of looping.
 */
const MAX_OVERFLOW_COMPACTIONS = 2;

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

/**
 * Sleep `ms`, resolving early if the turn is aborted (item 1 retry backoff).
 * Resolves `true` when the wait was cut short by an abort, `false` when the full
 * delay elapsed — so a user Stop during a Retry-After backoff ends the turn
 * immediately instead of after the (possibly minutes-long) wait.
 */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  if (ms <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener('abort', onAbort, { once: true });
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
  // CACHE-1 (docs/agent-port-plan.md): cache the system+tools prefix on Anthropic
  // by attaching one breakpoint to the stable last tool (see aiTools). Other
  // providers ignore the extra per-tool option, so it is always safe to pass.
  //
  // syncContextBeforeModelCall (SECOND-PASS item 6): the tool set is now built
  // FRESH per step from {@link listMcpTools}, not captured once at turn start, so
  // an MCP reconnect or a newly-appeared plugin tool (the MCP-1 reconnect work on
  // this branch) becomes callable MID-TURN instead of only on the next startTurn.
  // `listMcpTools` is a cheap sorted snapshot of the in-memory registry, and its
  // tail is the stable built-in `ASK_USER_DEF` (so the single cache breakpoint
  // still covers the whole prefix); when the registry is unchanged the bytes are
  // identical, so the Anthropic prompt cache still hits across steps. PROV-1
  // normalization keys off the CURRENT provider so a failed-over provider gets its
  // own correct shaping (and an Anthropic that failed over to Anthropic still caches).
  const buildTools = (provider: AgentSendInput['provider']) =>
    aiTools(listMcpTools(), {
      cacheable: provider === 'anthropic',
      provider,
    });
  // Fold instruction files + runtime grounding into the system prompt (Track B
  // §B2; Claude Code / Codex parity). Independent reads run in parallel:
  //  - repo conventions (AGENTS.md / CLAUDE.md + CLAUDE.local.md, @imports expanded)
  //  - the user's GLOBAL standing instructions (~/.claude, ~/.codex)
  //  - the runtime/environment block (date, OS, workspace, git state)
  const [rawWsInstructions, rawGlobalUserInstructions, envContext] = await Promise.all([
    loadWorkspaceInstructions(opts.ws),
    loadGlobalUserInstructions(),
    buildEnvironmentContext(opts.ws),
  ]);
  // Paragraph-level dedup across the instruction sources (item 7): repo
  // (AGENTS.md/steering) → global (~/.claude/CLAUDE.md) → Settings custom box, in
  // that DISPLAY order so the earliest copy of a repeated paragraph survives and
  // the later duplicates are dropped (saving tokens every turn). Pure + harnessed
  // (instruction-dedup.harness.ts). No-instruction path is unchanged.
  const [wsInstructions, globalUserInstructions, customInstructions] = dedupInstructionSources([
    rawWsInstructions,
    rawGlobalUserInstructions,
    opts.customInstructions,
  ]);
  // The current approval constraints, so the model knows what it may do (Codex
  // environment-context parity). Plan mode uses its own addendum below.
  const modeContext = approvalModeContext(opts.approvalMode);

  // Before-turn contributor seam (HOOK-1): run the registered first-party hooks
  // once, here, before any system prompt is assembled. The strings are spliced
  // into the join below between the user's standing instructions and the plan
  // addendum (trust order preserved). v1 registry is empty, so this is `[]` and
  // the assembled prompt is byte-identical to before. Captured by `activate`'s
  // closure, so a mid-turn fail-over reuses the same contributions.
  const contributorAddenda = await runBeforeTurnContributors({
    ws: opts.ws ? opts.ws.root : null,
    approvalMode: opts.approvalMode,
    provider: opts.provider,
    modelId: opts.model,
  });

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
        ? `${CLAUDE_CODE_SYSTEM_PREFIX}\n(The line above is an API routing requirement. Your name is Maru — identify yourself as such, never as "Claude Code".)\n\n${SYSTEM_PROMPT}`
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
      customInstructions.trim()
    );
    const trustFooter = hasFoldedInstructions ? SAFETY_FOOTER : null;
    const system = [
      baseSystem,
      modelGuidance(a.provider, a.modelId, a.modelReasoning),
      envContext,
      modeContext,
      wsInstructions,
      globalUserInstructions,
      customInstructions,
      // Before-turn contributors (HOOK-1): inserted BETWEEN the user's standing
      // instructions and the plan addendum by position (no numeric index) so the
      // trust order is preserved. Empty when no contributor is registered (v1),
      // and the `.filter()` below drops any empty/whitespace strings — so the
      // assembled prompt is byte-identical to before when the registry is empty.
      ...contributorAddenda,
      planAddendum,
      trustFooter,
    ]
      .filter((s): s is string => !!s && !!s.trim())
      .join('\n\n---\n\n');
    const codexBackend = a.provider === 'openai-codex';
    // Per-model output cap (item 1): resolve the catalog entry tolerating
    // slightly-varied ids (item 2) so a dotted/prefixed id still lifts the cap
    // above the 4096 floor.
    const catalogMax = resolveModelEntry(MODELS, a.provider, a.modelId)?.maxOutputTokens;
    return {
      provider: a.provider,
      modelId: a.modelId,
      model: buildModel(a.provider, a.modelId, a.auth, a.baseUrl),
      system,
      codexBackend,
      providerOptions: buildProviderOptions(a.provider, system, a.modelReasoning, opts.reasoningEffort),
      maxOutputTokens: codexBackend
        ? undefined
        : maxTokensForTurn(a.provider, a.modelReasoning, opts.reasoningEffort, catalogMax),
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
  // Windowed total-failure signal: a rolling count of tool failures within the
  // last WINDOW tool calls of THIS turn, regardless of which tool failed. The
  // per-tool `toolFailures` counter only escalates on CONSECUTIVE same-tool
  // failures, so a model alternating two distinct failing tools (A,B,A,B…) never
  // tripped recoveryHint. This windowed signal closes that gap: a turn that is
  // mostly failing — even across different tools — still escalates. `1` marks a
  // failure, `0` a success; the window slides as calls are recorded.
  const failureWindow: number[] = [];
  // Same-input loop detector (SECOND-PASS item 4): tracks consecutive identical
  // (name + args) tool calls so a success-spin (re-reading the same file forever)
  // is caught and nudged, which `toolFailures` (failures only) misses.
  let loopDetector: LoopDetectorState = emptyLoopDetectorState();
  // Task-delegation reminder (item: agent-usage-reminder): nudge once per turn
  // when the agent does a long run of direct survey reads without ever delegating
  // to a subagent. Suppressed the moment it uses spawn_subagent.
  let delegationReminder: DelegationReminderState = emptyDelegationReminderState();
  // Transient-retry / overflow-compaction bookkeeping (items 1 & 2). Bounded so a
  // persistently-failing provider or an un-shrinkable overflow can't spin forever:
  // after the caps spend we fall over (then surface). Turn-level (a retried step
  // re-runs the same `step` index, so a per-step reset would never trip the cap).
  let streamRetries = 0;
  let overflowCompactions = 0;
  const pickNextFallback = async (): Promise<ActiveTurnModel | null> => {
    for (const ref of opts.fallbacks) {
      const key = `${ref.provider}::${ref.model}`;
      if (triedModels.has(key)) continue;
      triedModels.add(key);
      const candidateProvider = ref.provider as AgentSendInput['provider'];
      const resolved = await resolveProviderAuth(candidateProvider);
      if (!resolved.ok) continue; // not connected (no key / dead OAuth) → skip
      const modelReasoning =
        resolveModelEntry(MODELS, candidateProvider, ref.model)?.reasoning ?? false;
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

  // TTSR mid-stream rule matcher (SECOND-PASS item 6). Constructed INERT: no rules
  // and `enabled: false`, so `ttsr.active` is false and `checkDelta` is a
  // guaranteed no-op. This is the safe hook point — the pure matcher
  // (ttsr-manager.ts) is fully implemented + tested, but the live abort+retry that
  // would act on a match is deferred (it is the transcript-integrity-sensitive
  // half). Turning it on later is: pass real rules + `enabled: true` here and
  // handle the returned matches in the delta loop, without touching the matcher.
  const ttsr = new TtsrManager([], { enabled: false });

  for (let step = 0; !opts.signal.aborted; step++) {
    if (opts.signal.aborted) return finish(S, 'completed', 'Stopped');
    // Step-budget backstop (turn-limits.ts): the wind-down notes below told the
    // model to wrap up; if it kept calling tools anyway, end the turn visibly
    // instead of looping forever.
    if (step >= MAX_TURN_STEPS) {
      return finish(S, 'completed', `Stopped at the ${MAX_TURN_STEPS}-step turn limit`);
    }
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

    let toolUses: { id: string; name: string; input: unknown; invalid?: boolean }[];
    try {
      // syncContextBeforeModelCall (item 6): rebuild the tool set for THIS step
      // and THIS (possibly failed-over) provider — picks up mid-turn MCP/plugin
      // registry changes and applies the current provider's schema shaping/cache.
      const tools = buildTools(current.provider);
      // CACHE-1 (docs/agent-port-plan.md): on Anthropic, add prompt-cache
      // breakpoints to the STABLE prefix so the large system block and the
      // message-history prefix aren't re-billed at full input price every step.
      // `aiTools` already caches the tools block; these add the system block and
      // the last-non-tail message (<= 4 breakpoints total, Anthropic's limit).
      // Non-Anthropic providers get the unchanged string / array (no-op).
      const cacheable = current.provider === 'anthropic';
      const res = streamText({
        model: current.model,
        // codex carries the system prompt in providerOptions.openai.instructions
        // (see above), so don't also pass it here or it lands twice.
        system: current.codexBackend ? undefined : cachedSystem(current.system, cacheable),
        messages: withMessagePrefixCache(S.transcript, cacheable),
        tools,
        maxOutputTokens: current.maxOutputTokens,
        providerOptions: current.providerOptions,
        abortSignal: opts.signal,
      });
      // Consume the stream for live text; the assembled tool calls + usage come
      // from the settled promises afterwards.
      ttsr.resetBuffers(); // fresh per-step stream buffers (no-op while inert)
      for await (const part of res.fullStream) {
        if (part.type === 'text-delta') {
          textPart.text += part.text;
          // TTSR hook point (item 6): while inert (`ttsr.active === false`) this
          // returns [] and changes nothing. The deferred live path would, on a
          // match, abort this stream + re-inject the matched rule + retry the step.
          const matches = ttsr.checkDelta(part.text, { source: 'text' });
          if (matches.length > 0) {
            // Intentionally inert: with no enabled rules this branch is unreachable.
            // Left as the explicit seam for the deferred abort+retry wiring.
            void matches;
          }
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
      // `invalid` (item 3): the AI SDK marks a tool call whose JSON arguments
      // couldn't be parsed `dynamic: true, invalid: true` (rather than throwing),
      // so it surfaces here. We carry the flag through to dispatch and answer it
      // with an immediate JSON-correction reminder on the FIRST failure.
      toolUses = calls.map((c) => ({
        id: c.toolCallId,
        name: c.toolName,
        input: c.input,
        ...(('invalid' in c && c.invalid === true) ? { invalid: true } : {}),
      }));
      S.state.usage.inputTokens += usage.inputTokens ?? 0;
      S.state.usage.outputTokens += usage.outputTokens ?? 0;
      // The latest call's input size is the live context-window occupancy (the
      // whole S.transcript is re-sent each step), so overwrite rather than sum —
      // this drives the usage gauge and the auto-compaction threshold.
      if (usage.inputTokens) S.state.usage.contextTokens = usage.inputTokens;
      // Cache observability: the Anthropic prompt-cache READ count for THIS call —
      // the slice of contextTokens that hit the cache instead of being re-billed at
      // full input price. Surfaced ALONGSIDE contextTokens (which is the input total
      // and so already INCLUDES cache reads) so a degraded hit rate — e.g. an
      // extended-thinking turn whose response-side thinking block keeps the
      // message-prefix cache from hitting — becomes visible instead of hiding inside
      // the total. Overwrite (latest-call snapshot, like contextTokens); 0 on
      // providers that don't report cache reads. See cacheReadTokensOf for the
      // structured/deprecated field precedence.
      S.state.usage.cachedInputTokens = cacheReadTokensOf(usage);
    } catch (err) {
      // Drop the optimistic streaming bubble if nothing was streamed into it, so
      // a failed/aborted step doesn't leave an empty assistant message behind.
      // Reasoning-only content still counts — keep a thinking-only bubble.
      const dropOptimisticBubble = (): void => {
        if (!textPart.text.trim() && !reasoningPart?.text.trim()) {
          const i = S.state.messages.indexOf(assistantMsg);
          if (i !== -1) S.state.messages.splice(i, 1);
        }
      };
      dropOptimisticBubble();
      if (opts.signal.aborted) return finish(S, 'completed', 'Stopped');

      // Classify the failure into the right recovery (items 1 & 2): a transient
      // blip → retry the SAME provider with backoff; a context overflow →
      // compact + retry (NOT a model swap); quota exhaustion / unrecoverable
      // client error → fall over to the next model; anything else → surface.
      const klass = classifyStreamError(err);
      const failOver = async (): Promise<boolean> => {
        const next = await pickNextFallback();
        if (!next) return false;
        // Discard any partial bubble from the failed attempt; the retry makes a
        // fresh one. (429 usually fires before any text streams.)
        const i = S.state.messages.indexOf(assistantMsg);
        if (i !== -1) S.state.messages.splice(i, 1);
        current = next;
        // Fresh provider: don't carry stale per-tool consecutive-failure counts
        // (else a tool that failed once before fail-over hits the recovery-hint
        // threshold prematurely on the new provider). The windowed signal resets
        // for the same reason — pre-failover failures shouldn't escalate the new
        // provider — and the protected nudge clears so a stale one isn't carried.
        toolFailures.clear();
        failureWindow.length = 0;
        S.persistentNudge = null;
        // Reset the stateful loop signals too: the same-input loop detector's ring
        // buffer / lastSignature / count and the delegation reminder's direct-read
        // run are pre-failover signals that must NOT carry across the provider swap
        // (else stale counts could immediately trip on the fresh provider).
        loopDetector = emptyLoopDetectorState();
        delegationReminder = emptyDelegationReminderState();
        emit();
        return true;
      };

      // 1) Transient (429 rate-limit / overload / 5xx / network): retry the same
      //    model with exponential backoff, honoring a server Retry-After. Only
      //    after the retry budget spends do we fall over (then surface) — so a
      //    single-provider user rides out a brief 429 instead of hard-failing.
      if (klass.action === 'retry' && streamRetries < MAX_STREAM_RETRIES) {
        streamRetries += 1;
        const delay = klass.retryAfterMs ?? backoffDelayMs(streamRetries - 1);
        const i = S.state.messages.indexOf(assistantMsg);
        if (i !== -1) S.state.messages.splice(i, 1);
        S.state.status = 'thinking';
        emit();
        const aborted = await sleepUnlessAborted(delay, opts.signal);
        if (aborted) return finish(S, 'completed', 'Stopped');
        step--; // re-run this step on the same model after the backoff
        continue;
      }

      // 2) Context-window overflow: compact, then retry. A different model has
      //    the same prompt + window, so failover is wrong here — compaction is.
      if (klass.action === 'compact' && overflowCompactions < MAX_OVERFLOW_COMPACTIONS) {
        overflowCompactions += 1;
        const i = S.state.messages.indexOf(assistantMsg);
        if (i !== -1) S.state.messages.splice(i, 1);
        S.state.status = 'thinking';
        emit();
        // Synchronous, mid-turn compaction (allowDuringTurn) shrinks S.transcript
        // before the retry; best-effort — if it can't help, the retry will surface.
        await compactConversation(undefined, S, { allowDuringTurn: true }).catch(() => {});
        step--; // re-run this step against the compacted transcript
        continue;
      }

      // 3) Failover-class (quota exhausted / unrecoverable), OR a transient/overflow
      //    that exhausted its budget above: try the next configured model.
      if (klass.action === 'failover' || klass.action === 'retry' || klass.action === 'compact') {
        if (await failOver()) {
          step--; // re-run this step index on the new model
          continue;
        }
      }

      // 4) Fatal (auth / bad request / thinking-block 400) or nothing left to try.
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

    // In-band JSON-parse-error reminder (item 3): a tool call whose arguments the
    // model emitted as invalid JSON arrives flagged `invalid`. We answer EACH such
    // call immediately with a corrective reminder (its own tool_result, so the
    // transcript stays valid) instead of dispatching un-parseable input — and we
    // do it on the FIRST failure, unlike the 2-strike `recoveryHint`.
    const invalidCallIds = new Set(toolUses.filter((t) => t.invalid === true).map((t) => t.id));

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

    // Post-compaction degradation monitor (item 3): right after a compaction,
    // watch the next few responses. If the model emits several consecutive
    // no-visible-text (tool-only / empty) responses, the summary was likely too
    // lossy and it's spinning. Advance the monitor here (pure counting); the
    // corrective note is injected only at a VALID transcript position — after
    // this step's tool results below — so it never splits a tool_use/tool_result
    // pair. Inert outside the window, so a healthy tool-only stretch is ignored.
    const advanced = advanceDegradationMonitor(
      {
        monitorRemaining: S.postCompactionMonitorRemaining,
        emptyStreak: S.postCompactionEmptyStreak,
      },
      textPart.text.trim().length > 0,
    );
    S.postCompactionMonitorRemaining = advanced.state.monitorRemaining;
    S.postCompactionEmptyStreak = advanced.state.emptyStreak;
    const degradedThisStep = advanced.degraded;
    if (degradedThisStep) {
      // Close the monitor so the note fires at most once per compaction.
      S.postCompactionMonitorRemaining = 0;
      S.postCompactionEmptyStreak = 0;
    }

    if (calls.length === 0) {
      // Empty response: no text, no tools, no reasoning → surface as an error
      // instead of a silent blank bubble.
      if (!textPart.text.trim() && !reasoningPart?.text.trim()) {
        const i = S.state.messages.indexOf(assistantMsg);
        if (i !== -1) S.state.messages.splice(i, 1);
        // The empty assistant turn was already pushed to S.transcript above — drop
        // it so a resume / next turn never streams a content:[] assistant message
        // (AI-SDK ModelMessage contract requires non-empty assistant content).
        S.transcript.pop();
        return finish(
          S,
          'failed',
          undefined,
          `${current.provider} returned an empty response for model "${current.modelId}". The model produced no output — try again or switch models.`,
        );
      }
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

    // Execute the step's tool calls; collect one tool_result per call (S.transcript stays valid).
    S.state.status = 'working';
    emit();

    // Pre-flight ONE call: abort/ask_user/deny-list/mode blocks and the approval
    // park — everything that must stay strictly one-at-a-time (the approval card
    // and ask_user are single-slot surfaces). Returns the terminal result for a
    // blocked/denied/answered call, or null when the call is cleared to dispatch.
    const preflight = async (call: ToolCall): Promise<ToolResultPartLite | null> => {
      if (opts.signal.aborted) {
        call.state = 'aborted';
        return toolResult(call.id, call.name, 'aborted by user', true);
      }

      // ask_user: park the turn, surface the questions, resume with answers.
      if (call.name === ASK_USER) {
        const answered = await handleAskUser(S, opts.turnId, call, opts.signal);
        return toolResult(call.id, call.name, answered.content, answered.isError);
      }

      // Per-tool deny list (v6 §W7): a tool the user banned is blocked in EVERY
      // mode (even auto) — the tool-level twin of denyGlobs. Checked before any
      // approval path so it can't be auto-approved or "allow always"-ed.
      if (getSettingsSync().agent.denyTools.includes(call.name)) {
        call.state = 'denied';
        call.resultText = 'Blocked: deny list.';
        emit();
        return toolResult(
          call.id,
          call.name,
          `Blocked: "${call.name}" is on the user's tool deny list (Settings → Agent). Use a different approach.`,
          true,
        );
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
        return toolResult(
          call.id,
          call.name,
          planning
            ? 'Blocked: plan mode is active — do not edit. Finish researching and present a step-by-step plan; the user will switch to Ask or Auto to execute it.'
            : 'Blocked: the agent is in read-only mode. Switch to Ask or Auto in Settings → Agent to allow edits and code execution.',
          true,
        );
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
      if ((gatedApproval && !preApproved) || editPreview) {
        call.state = 'awaiting_approval';
        S.state.status = 'waiting_for_user';
        S.state.pendingApproval = {
          turnId: opts.turnId,
          callId: call.id,
          name: call.name,
          detail: describeToolInput(call.name, call.input),
          ...(editPreview ? { diffs: editDiffs(call.input) } : {}),
        };
        // Preview a gated browser action on the live page while it waits, so the
        // user sees the exact target before approving (Stagehand-style). Cleared
        // on the decision; the executor redraws its own highlight if approved.
        previewGatedAction(ctx.tabId, call.name, call.input);
        emit();
        const decision = await waitForApproval(S);
        clearActionPreview(ctx.tabId);
        S.approvalResolver = null;
        S.state.pendingApproval = null;
        if (opts.signal.aborted) {
          call.state = 'aborted';
          return toolResult(call.id, call.name, 'aborted by user', true);
        }
        // "Allow always": skip the prompt for later calls — this conversation
        // (in-memory) AND future ones (persisted, v6 §W7/U10; revocable in
        // Settings → Agent). Editor-preview parks aren't gated tools, so persist
        // only genuine gated tools.
        // Persist "Allow always" ONLY for genuine gated tools. An editor-preview
        // park is a UX safeguard (show the diff), not an approval gate, so it must
        // keep previewing every edit — never enter the allowed set (which line 597
        // reads via preApproved and would then silently bypass the preview).
        if (decision.approved && decision.always && gatedApproval) {
          S.sessionAllowedTools.add(call.name);
          const cur = getSettingsSync().agent.alwaysAllowTools;
          if (!cur.includes(call.name)) {
            void patchSettings({ agent: { alwaysAllowTools: [...cur, call.name] } });
          }
        }
        if (!decision.approved) {
          call.state = 'denied';
          call.resultText = 'Denied by the user.';
          S.state.status = 'working';
          emit();
          return toolResult(call.id, call.name, 'The user denied this tool call.', true);
        }
        S.state.status = 'working';
        emit();
      }
      return null;
    };

    // The side-effect-free product of dispatching one cleared call: its bounded
    // model-facing text plus the raw signals the SERIAL bookkeeping pass needs.
    // Carries no order-sensitive state itself, so several of these can be produced
    // concurrently (a parallel `shared` run) and reconciled in call order after.
    type DispatchedCall = {
      cappedText: string;
      isError: boolean;
      touchedPaths: readonly string[] | undefined;
      image: { data: string; mediaType: string } | undefined;
    };

    // Dispatch a CLEARED call through the bounded executor and produce its bounded
    // result + raw signals. Safe to run concurrently (foreground subagents stream
    // onto their own card; a `shared` run dispatches in parallel) — all
    // order-sensitive bookkeeping is deferred to {@link applyBookkeeping}.
    const dispatchCleared = async (call: ToolCall): Promise<DispatchedCall> => {
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
      // Per-tool intercept seam: a before-hook may BLOCK this cleared call with a
      // reason (an extra overlay on top of the approval/deny gating above). With
      // the v1 empty registry this is always null, so dispatch is unchanged.
      const interceptMeta = {
        name: call.name,
        input: call.input,
        ws: opts.ws ? opts.ws.root : null,
        provider: current.provider,
        modelId: current.modelId,
      };
      const blockedByHook = await runBeforeToolCall(interceptMeta);
      let out: ToolResult;
      if (blockedByHook) {
        out = { summary: `${call.name} blocked`, text: blockedByHook.reason, isError: true };
      } else {
        const dispatched = await dispatchToolBounded(call.name, call.input, dispatchCtx);
        // An after-hook may rewrite/annotate the model-facing fields (summary /
        // text / isError) — e.g. attach a verify-note. The structured side-channels
        // (edits/media/artifact/touchedPaths/image) ride through untouched, so a
        // hook can't drop a file edit or media artifact. Empty registry ⇒ no-op.
        const annotated = await runAfterToolCall(interceptMeta, {
          summary: dispatched.summary,
          text: dispatched.text,
          ...(dispatched.isError ? { isError: true } : {}),
        });
        out = {
          ...dispatched,
          summary: annotated.summary,
          text: annotated.text,
          isError: annotated.isError,
        };
      }
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
      // Per-tool output cap (item 7): bound the MODEL-facing text of high-volume
      // search/fetch tools to a context-window-aware char budget so one large
      // result can't silently force a compaction. The UI card (call.resultText,
      // set above) keeps the full output, and read_file is exempt (anchors).
      const currentContextWindow = resolveModelEntry(
        MODELS,
        current.provider,
        current.modelId,
      )?.contextWindow;
      const capped = out.isError
        ? { text: out.text, truncated: false }
        : capToolOutput(call.name, out.text, currentContextWindow);
      // Return only the side-effect-free pieces. The ORDER-SENSITIVE bookkeeping
      // (failure window / toolFailures / loop detector / delegation reminder /
      // nested-instruction claims) and the nudge text it produces are applied
      // SERIALLY in the model's original call order by the caller — running them
      // here would let a concurrently-dispatched `shared` run apply them in
      // nondeterministic completion order (regression A).
      return {
        cappedText: capped.text,
        isError: out.isError ?? false,
        touchedPaths: out.touchedPaths,
        image: out.image,
      };
    };

    // Apply the order-sensitive bookkeeping for ONE call and assemble its final
    // model-facing tool result. Runs SERIALLY in the model's original call order
    // (never concurrently) so the failure window, per-tool failure counts, loop
    // detector, and delegation reminder advance deterministically regardless of
    // how a parallel `shared` dispatch settled. Returns the result part plus this
    // call's protected nudge (recovery > loop-detector precedence), which the
    // caller folds into the step's strongest nudge.
    const applyBookkeeping = async (
      call: ToolCall,
      d: DispatchedCall,
    ): Promise<{ part: ToolResultPartLite; nudge: string | null }> => {
      let modelText = d.cappedText;
      // The strongest persistent nudge for THIS call — recovery (failure-driven)
      // or loop-detector. Returned to the caller, which carries the step's
      // strongest one onto the container as a compaction-PROTECTED note so a
      // mid-turn preemptive compaction can't summarize it away before the model acts.
      let persistentNudge: string | null = null;
      // Windowed failure signal (slides as every call settles): the rolling count
      // of failures within the last WINDOW calls. Drives recovery escalation for
      // ALTERNATING failing tools that the consecutive-same-tool counter misses.
      recordFailureWindow(failureWindow, d.isError);
      // Recovery hint (§G4): nudge the agent out of a retry loop when EITHER the
      // same tool keeps failing in a row OR the turn is failing broadly across
      // tools (windowed). Appended to the model-facing text AND carried as the
      // protected nudge so it survives a compaction boundary.
      if (d.isError) {
        const n = (toolFailures.get(call.name) ?? 0) + 1;
        toolFailures.set(call.name, n);
        const windowed = windowedFailureCount(failureWindow);
        const hint = recoveryHint(call.name, n, windowed);
        if (hint) {
          modelText = `${modelText}\n\n${hint}`;
          persistentNudge = hint;
        }
      } else {
        toolFailures.delete(call.name);
      }
      // Same-input loop detector (item 4): nudge when the model repeats the SAME
      // call (name + args) too many times in a row EVEN ON SUCCESS — a no-progress
      // spin `toolFailures` (failures only) can't see. ask_user/spawn meta-tools
      // are excluded (parking / fan-out are legitimately repeatable).
      if (call.name !== ASK_USER && call.name !== SPAWN_SUBAGENT && call.name !== SPAWN_BACKGROUND_AGENT) {
        const ld = recordLoopDetectorCall(loopDetector, call.name, call.input);
        loopDetector = ld.state;
        if (ld.tripped && ld.toolName) {
          const loopNudge = loopDetectorNudge(ld.toolName, ld.repeatedCount, ld.kind);
          modelText = `${modelText}\n\n${loopNudge}`;
          // A loop nudge on an OK call is still a not-yet-acted-on signal worth
          // protecting; a recovery nudge (failure) takes precedence when both fire.
          if (!persistentNudge) persistentNudge = loopNudge;
        }
      }
      // Task-delegation reminder (item: agent-usage-reminder): a delegation
      // (spawn_subagent) suppresses it; a long run of direct survey reads with no
      // delegation trips a once-per-turn nudge. Appended to the model-facing text.
      {
        const dr = recordDelegationCall(delegationReminder, call.name, call.name === SPAWN_SUBAGENT);
        delegationReminder = dr.state;
        if (dr.tripped) {
          modelText = `${modelText}\n\n${delegationReminderNudge(dr.state.directCount)}`;
        }
      }
      // Lazily inject not-yet-seen per-directory instruction files for any path
      // this tool entered (§B2 on-demand). Appended to the MODEL-facing result
      // only — the UI card (call.resultText) stays focused on the tool output. The
      // claim set is conversation-scoped + mutated here, so it too must run in
      // call order (which call first claims a shared file is deterministic).
      if (!d.isError && opts.ws && d.touchedPaths?.length) {
        const reminders: string[] = [];
        for (const rel of d.touchedPaths) {
          const block = await claimNestedInstructions(opts.ws.root, rel);
          if (block) reminders.push(block);
        }
        // Append to the ACCUMULATED modelText (which already carries the output
        // cap + any loop-detector/delegation nudges) — not raw out.text, which
        // would discard them.
        if (reminders.length > 0) modelText = `${modelText}\n\n${reminders.join('\n\n')}`;
      }
      // An inline image (screenshot tool) rides into the transcript as a
      // multipart tool result so a vision-capable model can SEE the page.
      const part = toolResult(call.id, call.name, modelText, d.isError, d.image);
      return { part, nudge: persistentNudge };
    };

    // Walk the calls in order. A run of CONSECUTIVE spawn_subagent calls is a
    // fan-out: each child's approval still parks one at a time (the approval
    // card is single-slot), but the approved children then execute concurrently
    // (in chunks of MAX_PARALLEL_SUBAGENTS) — so the model can issue several
    // spawns in one step and get real parallelism. Every other tool keeps the
    // strict sequential semantics: a later call sees the earlier call's effects.
    // Item 3: a malformed-JSON tool call is answered with a corrective reminder
    // and NEVER dispatched (its `input` is the raw unparsed string — running it
    // would just error opaquely). Returns the terminal result, or null to proceed.
    const interceptInvalidJson = (call: ToolCall): ToolResultPartLite | null => {
      if (!invalidCallIds.has(call.id)) return null;
      call.state = 'error';
      call.error = JSON_ERROR_REMINDER;
      call.resultText = JSON_ERROR_REMINDER;
      emit();
      return toolResult(call.id, call.name, JSON_ERROR_REMINDER, true);
    };

    // A call's scheduling class (item: per-tool concurrency). A `shared` call is
    // a read-only, side-effect-free tool whose ordering relative to siblings does
    // not matter, so a CONSECUTIVE run of them can dispatch in parallel. Anything
    // else is `exclusive` and keeps the strict one-at-a-time semantics (a later
    // call sees the earlier call's effects). spawn_subagent has its own fan-out
    // branch below and is never folded into a shared run.
    const isSharedCall = (call: ToolCall): boolean => {
      if (call.name === SPAWN_SUBAGENT) return false;
      const def = getMcpToolDef(call.name);
      return def ? isSharedTool(def) : false;
    };
    const toolResultParts: ToolResultPartLite[] = [];
    // The step's STRONGEST protected nudge, accumulated across ALL of this step's
    // calls in their original order and assigned to S.persistentNudge ONCE after
    // the step settles (below). pickStepNudge keeps the LATEST nudge and never
    // lets a later CLEAN call clear it (regression A) — so in a mixed
    // [failing, clean] shared run the failing call's nudge survives.
    let stepNudge: string | null = null;
    // Reconcile a settled run in the model's ORIGINAL call order: dispatched
    // calls get their order-sensitive bookkeeping applied here (serially, never
    // concurrently), terminal parts (invalid JSON / blocked) pass straight
    // through. Folds each call's nudge into the step nudge as it goes.
    const reconcileRun = async (
      run: readonly ToolCall[],
      settled: ReadonlyMap<string, DispatchedCall | ToolResultPartLite>,
    ): Promise<void> => {
      for (const call of run) {
        const entry = settled.get(call.id);
        if (!entry) continue; // unreachable — every call settles below
        if ('type' in entry) {
          // A terminal part (invalid JSON or blocked): no tool ran, no bookkeeping.
          toolResultParts.push(entry);
          continue;
        }
        const { part, nudge } = await applyBookkeeping(call, entry);
        stepNudge = pickStepNudge(stepNudge, nudge);
        toolResultParts.push(part);
      }
    };
    for (let ci = 0; ci < calls.length; ) {
      if (calls[ci].name !== SPAWN_SUBAGENT) {
        // A run of consecutive `shared` (read-only) calls: preflight each one in
        // order (approval/abort gating stays single-slot — shared tools are
        // ungated so they don't park, but the invariant is preserved), then
        // dispatch the cleared ones concurrently in chunks. The settled map keeps
        // the transcript in the model's original call order. A lone shared call
        // falls through this with a 1-element run (a Promise.all of one) — same
        // result as the serial path, no special-casing needed.
        if (isSharedCall(calls[ci])) {
          const run: ToolCall[] = [];
          while (ci < calls.length && isSharedCall(calls[ci])) {
            run.push(calls[ci]);
            ci += 1;
          }
          const settled = new Map<string, DispatchedCall | ToolResultPartLite>();
          const cleared: ToolCall[] = [];
          for (const call of run) {
            const invalid = interceptInvalidJson(call);
            if (invalid) {
              settled.set(call.id, invalid);
              continue;
            }
            const blocked = await preflight(call);
            if (blocked) settled.set(call.id, blocked);
            else cleared.push(call);
          }
          for (let s = 0; s < cleared.length; s += MAX_PARALLEL_SHARED_TOOLS) {
            const chunk = cleared.slice(s, s + MAX_PARALLEL_SHARED_TOOLS);
            const outs = await Promise.all(chunk.map((call) => dispatchCleared(call)));
            chunk.forEach((call, k) => settled.set(call.id, outs[k]));
          }
          // Bookkeeping is applied SERIALLY here in run order regardless of the
          // concurrent completion order above (regression A).
          await reconcileRun(run, settled);
          continue;
        }
        const call = calls[ci];
        ci += 1;
        const invalid = interceptInvalidJson(call);
        if (invalid) {
          toolResultParts.push(invalid);
          continue;
        }
        const blocked = await preflight(call);
        if (blocked) {
          toolResultParts.push(blocked);
          continue;
        }
        const dispatched = await dispatchCleared(call);
        const { part, nudge } = await applyBookkeeping(call, dispatched);
        stepNudge = pickStepNudge(stepNudge, nudge);
        toolResultParts.push(part);
        continue;
      }
      const run: ToolCall[] = [];
      while (ci < calls.length && calls[ci].name === SPAWN_SUBAGENT) {
        run.push(calls[ci]);
        ci += 1;
      }
      const settled = new Map<string, DispatchedCall | ToolResultPartLite>();
      const cleared: ToolCall[] = [];
      for (const call of run) {
        const invalid = interceptInvalidJson(call);
        if (invalid) {
          settled.set(call.id, invalid);
          continue;
        }
        const blocked = await preflight(call);
        if (blocked) settled.set(call.id, blocked);
        else cleared.push(call);
      }
      for (let s = 0; s < cleared.length; s += MAX_PARALLEL_SUBAGENTS) {
        const chunk = cleared.slice(s, s + MAX_PARALLEL_SUBAGENTS);
        const outs = await Promise.all(chunk.map((call) => dispatchCleared(call)));
        chunk.forEach((call, k) => settled.set(call.id, outs[k]));
      }
      await reconcileRun(run, settled);
    }
    // Assign the step's strongest protected nudge ONCE, after every call settled.
    // Setting it per step a nudge fires (rather than only on change) keeps it live
    // until the model changes behavior; a step with NO nudge clears it so a stale
    // one isn't re-stamped onto a future compaction after the model has recovered
    // — but a CLEAN call within an otherwise-nudging step can no longer clear it
    // (pickStepNudge preserves the latest), which was regression A.
    S.persistentNudge = stepNudge;

    // Near the step budget, ride a wind-down note on the last tool result so
    // the model wraps up on its own before the hard cutoff above.
    const limitNote = stepLimitNote(step + 1);
    if (limitNote) appendNoteToLastToolResult(toolResultParts, limitNote);
    S.transcript.push({ role: 'tool', content: toolResultParts });
    if (opts.signal.aborted) return finish(S, 'completed', 'Stopped');

    // Degradation corrective note (item 3): the monitor flagged this step's
    // response. Inject the nudge HERE — after the tool results — so every
    // tool_use from this step keeps its paired tool_result and the transcript
    // stays valid before the next model call.
    if (degradedThisStep) {
      S.transcript.push({
        role: 'user',
        content:
          '[system] You have produced several responses with no explanation since the last context compaction. The compacted summary above may be missing detail. Before continuing, briefly re-state in plain text what you are doing and why — re-reading the summary and any files it references if needed — then proceed.',
      });
      emit();
    }

    // Preemptive compaction (item 2): a long multi-tool turn can cross the
    // context threshold mid-turn — the auto-compact in finish() only fires at
    // turn end, so without this the NEXT model call below overflows. Compact
    // BETWEEN tool results and the next model call, synchronously, guarded by a
    // cooldown so a tool-heavy turn can't thrash the compactor. The current
    // model call already consumed `usage.inputTokens` (= live context), so the
    // ratio reflects what the next call would send.
    if (shouldPreemptiveCompact(S)) {
      await compactConversation(undefined, S, { allowDuringTurn: true }).catch(() => {});
      S.state.status = 'thinking';
      emit();
    }
  }

  finish(S, 'completed', 'Stopped');
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
 * The model-facing reminder injected as the tool_result for a call whose JSON
 * arguments couldn't be parsed (item 3 / omo json-error-recovery). Fires on the
 * FIRST malformed call — unlike the 2-strike {@link recoveryHint} — so the model
 * corrects its syntax immediately instead of repeating the same broken call.
 */
const JSON_ERROR_REMINDER =
  '[invalid tool arguments] The arguments for this tool call were not valid JSON, so the call could not be run. ' +
  'Look at the schema, fix the JSON syntax (balanced braces/brackets, quoted keys, escaped quotes, no trailing commas), ' +
  'and re-issue the call with valid arguments. Do not repeat the exact same malformed call.';

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
  // An early-end note (user Stop / dropped connection) shows as an interrupt
  // LABEL, not a fake assistant message in the S.transcript (v3 polish).
  S.state.endNote = note ?? null;
  S.state.status = status;
  // The persistent recovery/loop nudge is a turn-local signal — clear it at turn
  // end so a not-yet-acted-on nudge never leaks into the NEXT turn (or the
  // end-of-turn auto-compaction below, which would otherwise re-stamp it).
  S.persistentNudge = null;
  // Scrub before it crosses to the renderer — provider/OAuth error bodies in the
  // message can carry tokens/keys/PII (scrubText is idempotent + already applied
  // to humanizeModelError at its other callers).
  S.state.error = error ? scrubText(error) : null;
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

/**
 * Emergency compaction floor — fires regardless of the auto-compact setting and
 * regardless of whether the model's context window is known. It's the backstop
 * for unbounded transcript growth on disabled auto-compact or unlisted / custom
 * / openai-compat models, where `shouldAutoCompact`'s ratio path can't compute a
 * threshold. See `emergencyCompactionReason` for the ceilings.
 */
function shouldEmergencyCompact(S: ThreadContainer): boolean {
  const transcriptChars = S.transcript.reduce((n, m) => n + messageChars(m), 0);
  return emergencyCompactionReason(S.transcript.length, transcriptChars) !== null;
}

/** True when auto-compaction is enabled and the live context is over threshold. */
function shouldAutoCompact(S: ThreadContainer): boolean {
  // Emergency floor first: an unconditional backstop that fires even when
  // auto-compact is disabled or the model's context window is unknown.
  if (shouldEmergencyCompact(S)) return true;
  const cfg = getSettingsSync().agent.autoCompact;
  if (!cfg.enabled) return false;
  const ctx = S.state.usage.contextTokens;
  if (ctx <= 0) return false;
  const window = resolveModelEntry(
    MODELS,
    S.conversationProvider,
    S.conversationModel,
  )?.contextWindow;
  if (!window) return false;
  return ctx / window >= cfg.threshold;
}

/**
 * Minimum gap between two preemptive (mid-turn) compactions on one container, so
 * a long tool-heavy turn can't thrash the compactor (item 2). A normal turn-end
 * auto-compact is not gated by this — only the mid-turn path is.
 */
const PREEMPTIVE_COMPACTION_COOLDOWN_MS = 60_000;

/**
 * Whether to compact mid-turn, BEFORE the next model call (item 2). Reuses the
 * same over-threshold decision as the turn-end auto-compact, but adds a cooldown
 * lock so a turn that keeps crossing the threshold doesn't compact on every
 * step. The emergency floor (transcript size) bypasses the cooldown — at that
 * point growth is unbounded and a thrash is preferable to an overflow.
 */
function shouldPreemptiveCompact(S: ThreadContainer): boolean {
  if (!shouldAutoCompact(S)) return false;
  if (shouldEmergencyCompact(S)) return true;
  if (S.starting) return false;
  return Date.now() - S.lastCompactionAt >= PREEMPTIVE_COMPACTION_COOLDOWN_MS;
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
  // Bind to a SPECIFIC thread when one is named (canvas cards each own a thread,
  // all live at once); otherwise the workspace's active thread, then the global.
  const S =
    (input.threadId ? containerForThread(input.threadId) : null) ??
    (input.workspaceId ? containerForWorkspace(input.workspaceId) : currentContainer());
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
      ws = input.workspaceId ? getWorkspaceSummary(input.workspaceId) : requireWorkspace().ws;
      if (!ws) throw new Error('no workspace is open');
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
      // A fresh conversation began — let stateful plugins initialize per-chat
      // state (item: plugin onSession). No notifier registered ⇒ a no-op.
      notifySessionStart(S);
    }
    S.conversationProvider = input.provider;
    S.conversationModel = input.model;
    S.state.activeSessionId = S.conversationId;
    S.controller = new AbortController();
    S.activeTabId = input.tabId;
    S.state.turnId = turnId;
    // Runtime marker for turn-level rollback (restore the page on Revert all).
    recordTurnStartUrl(turnId, input.tabId);
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
      resolveModelEntry(MODELS, input.provider, input.model)?.reasoning ?? false;
    // Deep-thinking mode active (think/ultrathink, sticky): raise this turn's
    // reasoning effort to the max for a reasoning model. Never lowers the
    // configured effort and is a no-op for non-reasoning models.
    const reasoningEffort =
      modelReasoning && modeRaisesThinking(S.activeModes) ? 'high' : agentSettings.reasoningEffort;
    // Snapshot the working tree before the agent touches it (§3.6), so the whole
    // turn — including any terminal-driven changes — can be rolled back as a unit.
    // Awaited so the snapshot precedes the first edit; best-effort (never blocks).
    // ws.root is already the effective agent root (worktree when isolated).
    if (ws) await recordTurnCheckpoint(turnId, ws.root).catch(() => undefined);
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
      // Phone-remote unattended mode was removed with the relay/bridge; the agent
      // always honors the configured approval mode now.
      unattended: false,
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

/**
 * Session handoff (SECOND-PASS: gajae handoff-generation-pipeline.md). Generate an
 * explicit LLM checkpoint of the LIVE transcript on the addressed thread, and —
 * when `startNew` is set — reset that thread and seed a fresh session with the
 * handoff document so work continues with full context but a clean window.
 *
 * The generation step ({@link generateHandoff}) is non-destructive: it only reads
 * S.transcript. The optional seed reuses the existing reset + startTurn paths
 * unchanged (the seed rides in as a normal first user message), so transcript
 * integrity and every turn-setup guard are preserved. Returns the document either
 * way; `seededTurnId` is present only when a fresh session was started.
 */
export async function handoffConversation(input: {
  provider?: ProviderId;
  model?: string;
  workspaceId?: WorkspaceId;
  threadId?: string;
  focus?: string;
  startNew?: boolean;
}): Promise<HandoffResult & { seededTurnId?: string }> {
  const S =
    (input.threadId ? containerForThread(input.threadId) : null) ??
    (input.workspaceId ? containerForWorkspace(input.workspaceId) : currentContainer());
  // Capture provider/model BEFORE any reset clears them — a seeded session must
  // start on the same provider/model the handoff was generated against, unless the
  // caller explicitly overrides.
  const seedProvider = input.provider ?? S.conversationProvider ?? undefined;
  const seedModel = input.model ?? S.conversationModel ?? undefined;
  const result = await generateHandoff(input.focus, S);
  if (!result.ok) return result;
  if (!input.startNew) return result;
  // Seed a fresh session: clear the thread (refused mid-turn — generateHandoff
  // already guarded busy, and reset re-checks), then send the handoff document as
  // the first prompt of the new conversation. A missing provider/model (e.g. a
  // never-run thread) means we can't start a turn — return the doc without seeding.
  if (!seedProvider || !seedModel || !isProviderId(seedProvider)) return result;
  if (!resetConversation(S)) return result;
  const seeded = await startTurn({
    provider: seedProvider,
    model: seedModel,
    prompt: buildHandoffSeed(result.document),
    captures: [],
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
  return seeded.ok ? { ...result, seededTurnId: seeded.turnId } : result;
}

