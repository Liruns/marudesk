import { randomUUID } from 'node:crypto';
import type {
  WorkspaceRecord,
  WorkspaceRootInput,
  WorkspaceRootSummary,
  WorkspaceSummary,
} from '../shared/workspace';
import { obj, str } from './ipc/validate';
import { summarizeWorkspace } from './workspace-index';

/**
 * Pure id/record helpers for the workspace registry: generate ids, parse a root
 * input, summarize a root path, and project a multi-root record+root down to the
 * legacy single-root WorkspaceSummary shape. No registry state — split out of
 * workspace-registry.ts so it holds the stateful registry + handlers.
 */

export function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function rootToLegacySummary(
  record: WorkspaceRecord,
  root: WorkspaceRootSummary,
): WorkspaceSummary {
  return {
    root: root.root,
    name: record.roots.length > 1 ? `${record.name} / ${root.name}` : record.name,
    files: root.files,
    source: root.source,
    truncated: root.truncated,
  };
}

export function toRootInput(value: unknown, index: number): WorkspaceRootInput {
  const p = obj(value, `roots[${index}]`);
  return {
    name: str(p.name, `roots[${index}].name`).trim(),
    path: str(p.path, `roots[${index}].path`),
  };
}

export async function summarizeRoot(input: WorkspaceRootInput): Promise<WorkspaceRootSummary> {
  const name = input.name.trim();
  if (!name) throw new Error('root name must not be empty');
  const summary = await summarizeWorkspace(input.path);
  return {
    id: createId('root'),
    name,
    root: summary.root,
    files: summary.files,
    source: summary.source,
    truncated: summary.truncated,
  };
}
