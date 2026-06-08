import { scrubText } from '../../shared/scrub';
import { toMessage } from '../../shared/to-message';
import type { BackgroundTask } from '../../shared/agent';
import { S, uid, containers, emitContainer } from './loop-state';
import { parseSubagentRequest, recordSubagentInput, SubagentInputError } from './subagent-request';
import { runChildAgent } from './subagent-runtime';
import type { SubagentRunner } from './subagent-types';
import type { ToolContext, ToolResult } from './tools/types';

/**
 * The detached background-agent registry (docs/background-agent-design.md).
 *
 * Unlike `spawn_subagent` — which the loop `await`s, blocking the parent turn
 * until the child returns — a background agent is kicked off WITHOUT awaiting and
 * keeps running past the turn that started it. Its lifecycle lives here, in a
 * main-process module registry independent of the loop's {@link S} singleton; we
 * mirror it into `S.state.background` (and `emit()`) so the renderer/bridge see it
 * through the existing single snapshot.
 *
 * Safety (§6): the child reuses {@link runChildAgent}, whose toolset is read-only +
 * non-gated, so a detached agent can never reach an approval park (which, with no
 * human watching, would stall forever). Write-capable background agents are a
 * deliberate non-goal until the subagent unified approval queue exists.
 */

type BackgroundEntry = {
  /** The projected task (mutated in place; the same ref rides in S.state.background). */
  readonly task: BackgroundTask;
  /** Independent abort — turn end must not kill the detached child. */
  readonly controller: AbortController;
  /** Resolves when the child settles; exposed for tests via whenBackgroundSettled. */
  readonly promise: Promise<void>;
  /** Owning conversation — cleared/aborted on reset/resume so tasks don't leak. */
  readonly conversationId: string;
};

/** Cap on concurrently active (running) background agents per conversation (§8). */
const MAX_ACTIVE_BACKGROUND = 4;

/**
 * Cap on retained TERMINAL (done/error/cancelled) tasks per conversation (audit
 * H6). Without this the registry grew unbounded — terminal tasks were only ever
 * removed on reset/resume — so a long-lived chat that spawns many background
 * agents leaked them all. Running tasks are never evicted; the oldest finished
 * ones drop once we're over the cap.
 */
const MAX_TERMINAL_BACKGROUND = 20;

const registry = new Map<string, BackgroundEntry>();

let testRunner: SubagentRunner | null = null;

/** Test seam: swap the child runner so harnesses don't hit a real provider. */
export function setBackgroundRunnerForTests(runner: SubagentRunner | null): void {
  testRunner = runner;
}

/** Test seam: await a specific task's settlement (resolves even on error/cancel). */
export function whenBackgroundSettled(id: string): Promise<void> | undefined {
  return registry.get(id)?.promise;
}

/**
 * `spawn_background_agent` — loop-intercepted. Validates the request, registers a
 * running task, kicks the child off DETACHED (no await), and returns immediately
 * with the task id so the parent turn proceeds.
 */
export function startBackgroundAgentTool(input: unknown, ctx: ToolContext): ToolResult {
  let request;
  try {
    request = parseSubagentRequest(recordSubagentInput(input), ctx);
  } catch (err) {
    const message =
      err instanceof SubagentInputError || err instanceof Error ? err.message : String(err);
    return { summary: 'spawn_background_agent failed', text: scrubText(message), isError: true };
  }

  // Key the task to the TURN's thread (Stage 12-B-2), so a background agent
  // spawned by a non-active thread belongs to that thread, not the active one.
  const conversationId = ctx.thread?.conversationId ?? S.conversationId ?? '';
  const active = [...registry.values()].filter(
    (e) => e.conversationId === conversationId && e.task.status === 'running',
  ).length;
  if (active >= MAX_ACTIVE_BACKGROUND) {
    return {
      summary: 'spawn_background_agent rejected',
      text: `Too many active background agents (limit ${MAX_ACTIVE_BACKGROUND}). Collect or cancel one before spawning another.`,
      isError: true,
    };
  }

  const id = uid('bg');
  const controller = new AbortController();
  const task: BackgroundTask = {
    id,
    label: request.label,
    task: request.task,
    provider: request.provider,
    model: request.model,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
    collected: false,
  };
  const childCtx: ToolContext = {
    ...ctx,
    signal: controller.signal,
    provider: request.provider,
    model: request.model,
  };
  const runner = testRunner ?? runChildAgent;
  // Start the child synchronously (so it's truly running before we return), but
  // never await it — that's what makes the agent detached. A synchronous throw
  // from the runner is folded into a terminal error result.
  let work: Promise<ToolResult>;
  try {
    work = Promise.resolve(runner(request, childCtx));
  } catch (err) {
    work = Promise.resolve(errorResult(err));
  }
  const promise = work
    .then((out) => settle(id, controller, out))
    .catch((err) => settle(id, controller, errorResult(err)));

  registry.set(id, { task, controller, promise, conversationId });
  syncIntoState();
  return {
    summary: `background ${request.label}`,
    text: `Started background agent ${id} ("${request.label}") on ${request.provider}/${request.model}. It runs detached; call collect_background_agent with id "${id}" to read its result, or omit id to list all.`,
    isError: false,
  };
}

/** `collect_background_agent` — list all, or fetch one task's status/result. */
export function collectBackgroundTool(input: unknown, ctx?: ToolContext): ToolResult {
  const id = readId(input);
  const conversationId = ctx?.thread?.conversationId ?? S.conversationId ?? '';
  const own = [...registry.values()].filter((e) => e.conversationId === conversationId);

  if (!id) {
    if (own.length === 0) {
      return { summary: 'no background agents', text: 'No background agents in this conversation.' };
    }
    const lines = own
      .map((e) => e.task)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((t) => `- ${t.id} "${t.label}" ${t.provider}/${t.model} — ${t.status}${t.collected ? ' (collected)' : ''}`);
    return { summary: `${own.length} background agent(s)`, text: lines.join('\n') };
  }

  const entry = own.find((e) => e.task.id === id);
  if (!entry) {
    return { summary: 'unknown background agent', text: `No background agent "${id}" in this conversation.`, isError: true };
  }
  const t = entry.task;
  if (t.status === 'running') {
    return { summary: `background ${t.label} running`, text: `Background agent ${id} ("${t.label}") is still running.` };
  }
  // Reading any terminal task marks it collected (done OR error/cancelled), so the
  // tray badge and the no-id list stop re-surfacing what the model already read.
  if (!t.collected) {
    t.collected = true;
    syncIntoState();
  }
  if (t.status !== 'done') {
    return { summary: `background ${t.label} ${t.status}`, text: `Background agent ${id} ("${t.label}") ${t.status}: ${t.error ?? 'no detail'}.` };
  }
  return { summary: `background ${t.label} done`, text: t.result ?? '(no report)' };
}

/** `cancel_background_agent` — abort a running task by id. */
export function cancelBackgroundTool(input: unknown, ctx?: ToolContext): ToolResult {
  const id = readId(input);
  if (!id) return { summary: 'cancel failed', text: 'cancel_background_agent requires an id.', isError: true };
  const conversationId = ctx?.thread?.conversationId ?? S.conversationId ?? '';
  const entry = [...registry.values()].find(
    (e) => e.conversationId === conversationId && e.task.id === id,
  );
  if (!entry) return { summary: 'unknown background agent', text: `No background agent "${id}".`, isError: true };
  if (entry.task.status !== 'running') {
    return { summary: 'already finished', text: `Background agent ${id} already ${entry.task.status}.` };
  }
  markTerminal(entry.task, 'cancelled', 'cancelled by user');
  entry.controller.abort();
  syncIntoState();
  return { summary: `cancelled ${entry.task.label}`, text: `Cancelled background agent ${id}.` };
}

/**
 * User-initiated cancel from the tray (audit H6) — the desktop counterpart to
 * the model's cancel_background_agent tool, so a runaway detached agent can be
 * stopped from the UI. Returns true if a running task was aborted.
 */
export function cancelBackgroundTask(id: string): boolean {
  const conversationId = S.conversationId ?? '';
  const entry = [...registry.values()].find(
    (e) => e.conversationId === conversationId && e.task.id === id,
  );
  if (!entry || entry.task.status !== 'running') return false;
  markTerminal(entry.task, 'cancelled', 'cancelled by user');
  entry.controller.abort();
  syncIntoState();
  return true;
}

/**
 * Abort + drop every background agent owned by a conversation. Called from
 * reset()/resumeSession() so detached work never bleeds into the next chat.
 */
export function cancelBackgroundForConversation(conversationId: string | null): void {
  let changed = false;
  for (const [id, entry] of registry) {
    if (entry.conversationId !== (conversationId ?? '')) continue;
    if (entry.task.status === 'running') entry.controller.abort();
    registry.delete(id);
    changed = true;
  }
  if (changed) syncIntoState();
}

/* ── internals ──────────────────────────────────────────────────────────── */

function settle(id: string, controller: AbortController, out: ToolResult): void {
  const entry = registry.get(id);
  if (!entry || entry.task.status !== 'running') return; // already cancelled/dropped
  if (controller.signal.aborted) {
    markTerminal(entry.task, 'cancelled', 'cancelled by user');
  } else if (out.isError) {
    markTerminal(entry.task, 'error', out.text);
  } else {
    entry.task.status = 'done';
    entry.task.finishedAt = Date.now();
    entry.task.result = out.text;
  }
  syncIntoState();
}

function markTerminal(task: BackgroundTask, status: 'error' | 'cancelled', error: string): void {
  task.status = status;
  task.finishedAt = Date.now();
  task.error = error;
}

function syncIntoState(): void {
  // Project the registry into EACH owning thread container by conversationId
  // (Stage 12-B-2), so a background agent spawned on a NON-active thread still
  // updates its own tray + summary — not just the active conversation's.
  const convIds = new Set<string>();
  for (const e of registry.values()) convIds.add(e.conversationId);
  for (const convId of convIds) evictTerminalTasks(convId);
  for (const c of containers()) {
    const convId = c.conversationId ?? '';
    c.state.background = [...registry.values()]
      .filter((e) => e.conversationId === convId)
      .map((e) => e.task)
      .sort((a, b) => a.startedAt - b.startedAt);
    emitContainer(c);
  }
}

/** Drop the oldest terminal tasks beyond MAX_TERMINAL_BACKGROUND (audit H6). */
function evictTerminalTasks(conversationId: string): void {
  const terminal = [...registry.entries()]
    .filter(([, e]) => e.conversationId === conversationId && e.task.status !== 'running')
    .sort((a, b) => (a[1].task.finishedAt ?? 0) - (b[1].task.finishedAt ?? 0));
  for (let i = 0; i < terminal.length - MAX_TERMINAL_BACKGROUND; i++) {
    registry.delete(terminal[i][0]);
  }
}

function readId(input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  return typeof o.id === 'string' ? o.id.trim() : '';
}

function errorResult(err: unknown): ToolResult {
  const message = toMessage(err);
  return { summary: 'background agent failed', text: message, isError: true };
}
