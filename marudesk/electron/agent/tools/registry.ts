import { ASK_USER, SPAWN_SUBAGENT, GATED_TOOLS, type McpGroup, type McpTool, type McpToolDef } from './types';
import { TOOL_SCHEMAS } from './schemas';
import { EXECUTORS } from './executors';
import { IMAGE_GENERATION_TOOL } from './image-generation';
import { VIDEO_GENERATION_TOOL } from './video-generation';
import { WEB_SEARCH_TOOL } from './web-search';
import { FETCH_URL_TOOL } from './fetch-url';

/**
 * The MCP descriptor layer (docs/context-mcp-design §1.1) — pairs each tool's
 * schema with its executor and the derived metadata the loop reads (group /
 * gated / write / requiresWeb / requiresWorkspace) instead of hard-coding
 * tool-name sets in the loop.
 */

const TOOL_GROUP: Record<string, McpGroup> = {
  run_command: 'terminal',
  read_file: 'files',
  read_diagnostics: 'devtools',
  list_files: 'files',
  grep: 'files',
  edit_file: 'files',
  multi_edit: 'files',
  get_console_errors: 'devtools',
  read_network: 'devtools',
  read_network_body: 'devtools',
  query_dom: 'browser',
  eval_js: 'browser',
  click: 'browser',
  fill: 'browser',
  press_key: 'browser',
  scroll: 'browser',
  reload_and_verify: 'browser',
  browser_cookies: 'browser',
  browser_storage: 'browser',
};
const WRITE_TOOL_NAMES = new Set(['edit_file', 'multi_edit', 'run_command', 'click', 'fill', 'press_key', 'scroll']);
const WEB_TOOL_NAMES = new Set([
  'get_console_errors',
  'query_dom',
  'eval_js',
  'click',
  'fill',
  'press_key',
  'scroll',
  'read_network',
  'read_network_body',
  'reload_and_verify',
  'browser_cookies',
  'browser_storage',
]);
const WORKSPACE_TOOL_NAMES = new Set(['read_file', 'list_files', 'grep', 'edit_file', 'multi_edit', 'run_command', 'read_diagnostics']);

/**
 * The original file/runtime/context tools, expressed as MCP tools (schema +
 * executor + derived metadata). The single source of truth for gated/write/group
 * is the maps above + {@link GATED_TOOLS}; the loop reads these flags off the
 * descriptor instead of hard-coding tool-name sets.
 */
export const BUILTIN_TOOLS: McpTool[] = [
  IMAGE_GENERATION_TOOL,
  VIDEO_GENERATION_TOOL,
  WEB_SEARCH_TOOL,
  FETCH_URL_TOOL,
  ...TOOL_SCHEMAS.flatMap((s) => {
  if (s.name === ASK_USER) return [];
  const exec = EXECUTORS[s.name];
  if (!exec) return [];
  return [
    {
      ...s,
      group: TOOL_GROUP[s.name] ?? 'files',
      gated: GATED_TOOLS.has(s.name),
      write: WRITE_TOOL_NAMES.has(s.name),
      requiresWeb: WEB_TOOL_NAMES.has(s.name),
      requiresWorkspace: WORKSPACE_TOOL_NAMES.has(s.name),
      exec,
    },
  ];
  }),
];

/** The ask_user definition (listed to the model; execution is loop-intercepted). */
export const ASK_USER_DEF: McpToolDef = {
  ...TOOL_SCHEMAS.find((s) => s.name === ASK_USER)!,
  group: 'ask',
};

/** The spawn_subagent definition is loop-intercepted so it can launch a child model. */
export const SPAWN_SUBAGENT_DEF: McpToolDef = {
  ...TOOL_SCHEMAS.find((s) => s.name === SPAWN_SUBAGENT)!,
  group: 'agent',
  gated: true,
};
