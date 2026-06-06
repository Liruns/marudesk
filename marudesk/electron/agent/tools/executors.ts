import { scrubText } from '../../../shared/scrub';
import { SPAWN_SUBAGENT, type Executor, type ToolContext, type ToolResult } from './types';
import { readFile, listFiles, grep, editFile, multiEdit } from './file-tools.ts';
import {
  getConsoleErrors,
  queryDom,
  evalJs,
  readNetwork,
  readNetworkBody,
  reloadAndVerify,
  browserCookies,
  browserStorage,
} from './runtime-tools.ts';
import { click, fill, pressKey, scroll } from './interaction-tools.ts';
import { runCommand } from './command-tools.ts';
import { readDiagnostics, runDiagnosticsTool } from './diagnostics-tool.ts';

/**
 * The agent tool registry (docs/agentic-chat-design.md §4) — the §9 promotion of
 * the assist-era capabilities into model-callable tools. The executors live in
 * focused per-family modules (file-tools / runtime-tools / interaction-tools,
 * with the shared CDP helpers in shared-helpers); this file just wires the names
 * the model calls to those implementations and owns the dispatch + approval-card
 * preview. Every executor delegates to the SAME validated path the rest of the
 * app uses, and every page-originated string is scrubbed via shared/scrub.ts.
 */

export const EXECUTORS: Record<string, Executor> = {
  read_file: readFile as Executor,
  run_command: runCommand as Executor,
  run_diagnostics: runDiagnosticsTool as Executor,
  read_diagnostics: readDiagnostics as Executor,
  list_files: listFiles as Executor,
  grep: grep as Executor,
  edit_file: editFile as Executor,
  multi_edit: multiEdit as Executor,
  get_console_errors: getConsoleErrors as Executor,
  query_dom: queryDom as Executor,
  eval_js: evalJs as Executor,
  click: click as Executor,
  fill: fill as Executor,
  press_key: pressKey as Executor,
  scroll: scroll as Executor,
  read_network: readNetwork as Executor,
  read_network_body: readNetworkBody as Executor,
  reload_and_verify: reloadAndVerify as Executor,
  browser_cookies: browserCookies as Executor,
  browser_storage: browserStorage as Executor,
};

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const exec = EXECUTORS[name];
  if (!exec) return { summary: `unknown tool ${name}`, text: `no such tool: ${name}`, isError: true };
  try {
    return await exec((input ?? {}) as Record<string, unknown>, ctx);
  } catch (err) {
    return { summary: `${name} error`, text: `${name} failed — ${scrubText((err as Error).message)}`, isError: true };
  }
}

/** A short, safe preview of a gated tool's input for the approval card. */
export function describeToolInput(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  if (name === 'generate_image') return typeof o.prompt === 'string' ? o.prompt.slice(0, 500) : '(no prompt)';
  if (name === 'generate_video') return typeof o.prompt === 'string' ? o.prompt.slice(0, 500) : '(no prompt)';
  if (name === SPAWN_SUBAGENT) return typeof o.task === 'string' ? o.task.slice(0, 500) : '(no task)';
  if (name === 'run_command') return typeof o.command === 'string' ? o.command.slice(0, 300) : '(no command)';
  if (name === 'run_diagnostics') return "run the project's type-check / diagnostics";
  if (name === 'eval_js') return typeof o.expression === 'string' ? o.expression.slice(0, 500) : '(no expression)';
  // Interaction tools (click/fill/press_key/scroll): show the action target plainly.
  if (name === 'click') return typeof o.selector === 'string' ? `click ${o.selector}`.slice(0, 300) : '(no selector)';
  if (name === 'fill') {
    const sel = typeof o.selector === 'string' ? o.selector : '?';
    const val = typeof o.value === 'string' ? o.value : '';
    return `fill ${sel} = ${val}`.slice(0, 300);
  }
  if (name === 'press_key') {
    const key = typeof o.key === 'string' ? o.key : '?';
    const sel = typeof o.selector === 'string' ? ` on ${o.selector}` : '';
    return `press ${key}${sel}`.slice(0, 300);
  }
  if (name === 'scroll') {
    if (typeof o.selector === 'string') return `scroll to ${o.selector}`.slice(0, 300);
    return `scroll ${o.direction === 'up' ? 'up' : 'down'}`;
  }
  // PC-control / path tools: show the target plainly — this is an approval card.
  if (typeof o.path === 'string') return o.path.slice(0, 300);
  if (typeof o.url === 'string') return o.url.slice(0, 300);
  return JSON.stringify(o).slice(0, 300);
}
