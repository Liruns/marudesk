import type {
  AgentConnection,
  AgentImageInput,
  AgentAnswers,
  AgentPlanStepStatus,
  AgentSendInput,
} from '../../shared/agent';
import type { AgentApprovalMode, ReasoningEffort } from '../../shared/settings';
import { isCapturePayload, type CapturePayload } from '../../shared/composer';
import { isProviderId } from '../../shared/providers';
import { arr, bool, nonEmptyStr, obj, optStr } from '../ipc/validate';

/** The valid plan-step statuses (mirror {@link AgentPlanStepStatus}). */
const PLAN_STEP_STATUSES: readonly AgentPlanStepStatus[] = ['pending', 'in_progress', 'done'];
/** The valid approval modes (mirror {@link AgentApprovalMode}). */
const APPROVAL_MODES: readonly AgentApprovalMode[] = ['read-only', 'ask', 'auto', 'plan'];
/** The valid reasoning efforts (mirror {@link ReasoningEffort}). */
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Upper bounds on attached images (untrusted: also arrives over the CLI bridge). */
const MAX_IMAGES = 8;
/** ~14M base64 chars ≈ 10 MB decoded — a generous ceiling for a screenshot. */
const MAX_IMAGE_DATA_CHARS = 14_000_000;

function isAgentImageInput(v: unknown): v is AgentImageInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.mediaType === 'string' &&
    o.mediaType.startsWith('image/') &&
    typeof o.data === 'string' &&
    o.data.length > 0 &&
    o.data.length <= MAX_IMAGE_DATA_CHARS
  );
}

/** Optional `images` array on a send payload → validated, count-capped list. */
function parseImages(value: unknown): AgentImageInput[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = arr(value, 'images');
  if (list.length > MAX_IMAGES) throw new Error(`too many images (max ${MAX_IMAGES})`);
  if (!list.every(isAgentImageInput)) throw new Error('images contains an invalid entry');
  return list as AgentImageInput[];
}

/**
 * Untrusted-payload parsers for the agent loop's public API, shared by BOTH the
 * `agent:*` IPC handlers (electron/agent/handlers.ts) and the CLI bridge router
 * (electron/cli-bridge) so the two entry points validate identically — the
 * bridge's request bodies are just as untrusted as a renderer's IPC payload, and
 * divergent validation is how a bridge quietly drifts from the surface it serves.
 *
 * These are deliberately the same shallow shape checks the rest of the IPC layer
 * uses (electron/ipc/validate.ts); the loop owns all deeper invariants.
 */

/** `agent:send` / `POST /agent/send` body → {@link AgentSendInput}. */
export function parseSendInput(payload: unknown): AgentSendInput {
  const o = obj(payload);
  if (!isProviderId(o.provider)) throw new Error('provider must be a known provider id');
  const captures = arr(o.captures, 'captures');
  if (!captures.every(isCapturePayload)) throw new Error('captures contains an invalid entry');
  return {
    provider: o.provider,
    model: nonEmptyStr(o.model, 'model'),
    prompt: nonEmptyStr(o.prompt, 'prompt'),
    workspaceId: optStr(o.workspaceId, 'workspaceId'),
    captures: captures as CapturePayload[],
    images: parseImages(o.images),
    tabId: optStr(o.tabId, 'tabId'),
    threadId: optStr(o.threadId, 'threadId'),
    connections: parseConnections(o.connections),
  };
}

/**
 * Validate an `agent:handoff` payload (SECOND-PASS session handoff). All fields
 * optional: provider/model seed a fresh session (must be a known provider when
 * present); focus folds extra detail into the handoff; startNew resets + seeds.
 */
export function parseHandoff(payload: unknown): {
  provider?: import('../../shared/providers').ProviderId;
  model?: string;
  workspaceId?: string;
  threadId?: string;
  focus?: string;
  startNew?: boolean;
} {
  const o = obj(payload ?? {});
  if (o.provider !== undefined && !isProviderId(o.provider)) {
    throw new Error('provider must be a known provider id');
  }
  return {
    ...(o.provider !== undefined ? { provider: o.provider } : {}),
    model: optStr(o.model, 'model'),
    workspaceId: optStr(o.workspaceId, 'workspaceId'),
    threadId: optStr(o.threadId, 'threadId'),
    focus: optStr(o.focus, 'focus'),
    ...(o.startNew !== undefined ? { startNew: bool(o.startNew, 'startNew') } : {}),
  };
}

/** Validate the optional canvas `connections` array (identity-level card refs). */
function parseConnections(value: unknown): AgentConnection[] | undefined {
  // Lenient: this is optional best-effort context, so malformed input is ignored
  // rather than rejecting the whole send.
  if (!Array.isArray(value)) return undefined;
  const MAX = 24; // a sane cap; the model preamble shouldn't balloon
  const out: AgentConnection[] = [];
  for (const item of value.slice(0, MAX)) {
    if (typeof item !== 'object' || item === null) continue;
    const c = item as Record<string, unknown>;
    if (typeof c.kind !== 'string' || typeof c.title !== 'string') continue;
    out.push({
      kind: c.kind,
      title: c.title,
      ...(typeof c.locator === 'string' && c.locator ? { locator: c.locator } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** ask_user answers map: keep only string values (drop anything else). */
export function parseAnswers(value: unknown): AgentAnswers {
  const o = obj(value, 'answers');
  const out: AgentAnswers = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** `agent:abort` / `POST /agent/abort` body → the turn id to abort. */
export function parseAbort(payload: unknown): { turnId: string } {
  const o = obj(payload);
  return { turnId: nonEmptyStr(o.turnId, 'turnId') };
}

/** `agent:respond` / `POST /agent/respond` body. */
export function parseRespond(payload: unknown): {
  turnId: string;
  callId: string;
  answers: AgentAnswers;
} {
  const o = obj(payload);
  return {
    turnId: nonEmptyStr(o.turnId, 'turnId'),
    callId: nonEmptyStr(o.callId, 'callId'),
    answers: parseAnswers(o.answers),
  };
}

/**
 * `agent:edit-plan-step` / `POST /agent/edit-plan-step` body (U5 mobile parity).
 * Either cycles a step to a new `status` or removes it (`remove: true`); an
 * unknown status is dropped so a malformed remote payload becomes a loop no-op.
 */
export function parseEditPlanStep(payload: unknown): {
  id: string;
  status?: AgentPlanStepStatus;
  remove?: boolean;
  title?: string;
  add?: { title: string; after?: string };
} {
  const o = obj(payload);
  // Add op (steering): insert a person-authored step. Needs no existing id.
  if (o.add && typeof o.add === 'object') {
    const a = o.add as Record<string, unknown>;
    const title = typeof a.title === 'string' ? a.title : '';
    if (!title.trim()) throw new Error('add.title is required');
    return {
      id: '',
      add: { title, ...(typeof a.after === 'string' && a.after ? { after: a.after } : {}) },
    };
  }
  const status =
    typeof o.status === 'string' && (PLAN_STEP_STATUSES as readonly string[]).includes(o.status)
      ? (o.status as AgentPlanStepStatus)
      : undefined;
  const title = typeof o.title === 'string' ? o.title : undefined;
  return {
    id: nonEmptyStr(o.id, 'id'),
    status,
    remove: o.remove === true,
    ...(title !== undefined ? { title } : {}),
  };
}

/**
 * `POST /agent/set-approval-mode` body (U10 mobile parity) → a validated approval
 * mode. An unknown mode throws so the bridge returns a tidy `{ ok:false, error }`.
 */
export function parseSetApprovalMode(payload: unknown): { mode: AgentApprovalMode } {
  const o = obj(payload);
  if (typeof o.mode !== 'string' || !(APPROVAL_MODES as readonly string[]).includes(o.mode)) {
    throw new Error('mode must be one of read-only, ask, auto, plan');
  }
  return { mode: o.mode as AgentApprovalMode };
}

/**
 * `POST /agent/set-reasoning-effort` body (mobile parity for the desktop
 * reasoning dial) → a validated effort. An unknown effort throws so the bridge
 * returns a tidy `{ ok:false, error }`.
 */
export function parseSetReasoningEffort(payload: unknown): { effort: ReasoningEffort } {
  const o = obj(payload);
  if (typeof o.effort !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(o.effort)) {
    throw new Error('effort must be one of minimal, low, medium, high');
  }
  return { effort: o.effort as ReasoningEffort };
}

/**
 * The optional `{ workspaceId }` scope on a bridge `reset`/`snapshot` command —
 * a thin client targeting one workspace's active thread instead of the global
 * one. Tolerates a missing/empty body (the pre-workspace clients send `{}`).
 */
export function parseWorkspaceScope(payload: unknown): { workspaceId?: string } {
  if (payload === undefined || payload === null) return {};
  const o = obj(payload);
  return { workspaceId: optStr(o.workspaceId, 'workspaceId') };
}

/**
 * `POST /agent/revert-edit` body → the applied-edit id to revert plus the CLI
 * client's optional workspace scope (same shallow check the `agent:revert-edit`
 * IPC handler does on `editId`).
 */
export function parseRevertEdit(payload: unknown): { editId: string; workspaceId?: string } {
  const o = obj(payload);
  return {
    editId: nonEmptyStr(o.editId, 'editId'),
    workspaceId: optStr(o.workspaceId, 'workspaceId'),
  };
}

/** `agent:approve-tool` / `POST /agent/approve` body (missing `approved` → false). */
export function parseApprove(payload: unknown): {
  turnId: string;
  callId: string;
  approved: boolean;
  always: boolean;
} {
  const o = obj(payload);
  return {
    turnId: nonEmptyStr(o.turnId, 'turnId'),
    callId: nonEmptyStr(o.callId, 'callId'),
    approved: typeof o.approved === 'boolean' ? o.approved : false,
    // "Allow always for this session" — optional, defaults to false.
    always: typeof o.always === 'boolean' ? o.always : false,
  };
}
