/**
 * Spec lifecycle (docs/runtime-agent-absorption-2026-06.md §3.10) — lightweight
 * structured specs stored per-workspace under `.marudesk/specs/*.json` (mirrors
 * steering files + workflows). A spec is a title + markdown body + an ordered,
 * checkable task list, so a feature can be planned, tracked, and handed to the
 * agent as standing context. Intentionally simple: no branching/review state
 * machine — just the spec → tasks skeleton.
 */

export type SpecTask = {
  id: string;
  text: string;
  done: boolean;
};

/** The spec's place in its lifecycle (§3.10): draft → active → review → done. */
export type SpecStatus = 'draft' | 'active' | 'review' | 'done';

export const SPEC_STATUSES: readonly SpecStatus[] = ['draft', 'active', 'review', 'done'];

export function isSpecStatus(v: unknown): v is SpecStatus {
  return typeof v === 'string' && (SPEC_STATUSES as readonly string[]).includes(v);
}

export type Spec = {
  id: string;
  title: string;
  body: string;
  status: SpecStatus;
  tasks: SpecTask[];
  createdAt: number;
  updatedAt: number;
};

/** What the renderer sends to upsert a spec (id omitted ⇒ create). */
export type SpecInput = {
  id?: string;
  title: string;
  body: string;
  status?: SpecStatus;
  tasks: SpecTask[];
};
