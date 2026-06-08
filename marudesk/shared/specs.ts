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

export type Spec = {
  id: string;
  title: string;
  body: string;
  tasks: SpecTask[];
  createdAt: number;
  updatedAt: number;
};

/** What the renderer sends to upsert a spec (id omitted ⇒ create). */
export type SpecInput = {
  id?: string;
  title: string;
  body: string;
  tasks: SpecTask[];
};
