export type PatchOp = {
  path: string;
  oldString: string;
  newString: string;
};

export type PatchOpPreview =
  | {
      kind: 'edit';
      path: string;
      startLine: number;
      oldString: string;
      newString: string;
    }
  | {
      kind: 'create';
      path: string;
      newString: string;
    }
  | {
      kind: 'error';
      path: string;
      reason: string;
    };

export type PatchPreview = {
  ops: PatchOpPreview[];
  hasErrors: boolean;
};

export type ApplyOutcome = {
  path: string;
  kind: 'edit' | 'create';
};

export type ApplyError = {
  path: string;
  reason: string;
};

/**
 * The before/after content of one successfully-applied op — captured so the
 * agentic chat can show a diff and revert it (roadmap P2). The atomic apply
 * already reads `before` and computes `after`; this just surfaces them.
 */
export type AppliedChange = {
  path: string;
  kind: 'edit' | 'create';
  /** Pre-apply content, or null for a created file. */
  before: string | null;
  after: string;
};

export type ApplyResult = {
  ok: boolean;
  applied: ApplyOutcome[];
  errors: ApplyError[];
  /** Present only on a fully-successful apply (ok: true). */
  changes?: AppliedChange[];
};

/**
 * Canonical runtime guards for a {@link PatchOp}. A valid op needs a non-empty
 * path plus string old/new content. Shared by the patch handler (validating the
 * renderer payload) and the LLM tool-output validator so the two can't diverge.
 */
export function isPatchOp(value: unknown): value is PatchOp {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === 'string' &&
    v.path.length > 0 &&
    typeof v.oldString === 'string' &&
    typeof v.newString === 'string'
  );
}

export function isPatchOpArray(value: unknown): value is PatchOp[] {
  return Array.isArray(value) && value.every(isPatchOp);
}
