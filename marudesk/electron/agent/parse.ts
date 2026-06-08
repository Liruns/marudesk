import type {
  AgentImageInput,
  AgentAnswers,
  AgentPlanStepStatus,
  AgentSendInput,
} from '../../shared/agent';
import type { AgentApprovalMode } from '../../shared/settings';
import { isCapturePayload, type CapturePayload } from '../../shared/composer';
import { isProviderId } from '../../shared/providers';
import { arr, nonEmptyStr, obj, optStr } from '../ipc/validate';

/** The valid plan-step statuses (mirror {@link AgentPlanStepStatus}). */
const PLAN_STEP_STATUSES: readonly AgentPlanStepStatus[] = ['pending', 'in_progress', 'done'];
/** The valid approval modes (mirror {@link AgentApprovalMode}). */
const APPROVAL_MODES: readonly AgentApprovalMode[] = ['read-only', 'ask', 'auto', 'plan'];

/** Upper bounds on attached images (untrusted: also arrives over the relay). */
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
 * `agent:*` IPC handlers (electron/agent/handlers.ts) and the headless bridge
 * server (electron/server) so the two entry points validate identically — the
 * server's request bodies are just as untrusted as a renderer's IPC payload, and
 * divergent validation is how a relay quietly drifts from the surface it relays.
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
    captures: captures as CapturePayload[],
    images: parseImages(o.images),
    tabId: optStr(o.tabId, 'tabId'),
  };
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
} {
  const o = obj(payload);
  const status =
    typeof o.status === 'string' && (PLAN_STEP_STATUSES as readonly string[]).includes(o.status)
      ? (o.status as AgentPlanStepStatus)
      : undefined;
  return { id: nonEmptyStr(o.id, 'id'), status, remove: o.remove === true };
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
