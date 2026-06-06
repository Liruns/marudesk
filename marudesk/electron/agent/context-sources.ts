import type { McpTool } from './tools';
import {
  activateTabTool,
  closeTabTool,
  deleteMemoryTool,
  deleteSessionTool,
  listMemoryTool,
  listSessionsTool,
  listTabs,
  listTerminals,
  listWorkspaceFiles,
  listWorkspaces,
  navigateTab,
  openTab,
  readConsole,
  readEditor,
  readExplorer,
  readMemoryTool,
  readPage,
  readSessionTool,
  readTerminal,
  readWorkspaceFile,
  writeMemoryTool,
} from './context-executors.ts';

/**
 * The built-in context MCP descriptors (docs/context-mcp-design §2). The executor
 * implementations live in ./context-executors; this file is the model-facing
 * schema/registry that wires each tool name to its executor. Most are low-risk
 * read-only pulls of the user's own app state — see per-tool flags below.
 */

const strProp = (desc: string) => ({ type: 'string', description: desc });
const obj = (properties: Record<string, unknown>, required?: string[]) => ({
  type: 'object' as const,
  properties,
  ...(required ? { required } : {}),
  additionalProperties: false,
});

/**
 * The new context tools, as MCP descriptors. Most are low-risk read-only pulls of
 * the user's own app state. The exceptions: `write_memory` mutates state (flagged
 * `write`, so read-only mode refuses it); `read_terminal` can surface command
 * output (so it's `gated` — per-call approval); and `delete_session` /
 * `delete_memory` are destructive, so they're BOTH `write` (read-only refuses)
 * AND `gated` (per-call approval) — deleting the user's saved data is never silent.
 */
export const CONTEXT_TOOLS: McpTool[] = [
  {
    name: 'list_tabs',
    group: 'tabs',
    description:
      "List every open tab across the app (web pages, editors, terminals, settings, the AI Chat) with its id and what identifies it. The starting point for reading OTHER tabs' content.",
    inputSchema: obj({}),
    exec: () => listTabs(),
  },
  {
    name: 'open_tab',
    group: 'tabs',
    write: true,
    description:
      'Open and activate a new tab. kind="web" opens a page (pass url, or omit for a blank tab); kind="editor" opens a workspace file (pass path, plus workspaceId/rootId from list_workspaces, or omit them for the active workspace/root); kind can also be terminal|home|settings|agent. Returns the new tab id.',
    inputSchema: obj({
      kind: strProp('web | editor | terminal | home | settings | agent. Defaults to web when a url is given.'),
      url: strProp('For kind=web: URL or search text to load (omit for a blank tab).'),
      workspaceId: strProp('For kind=editor: workspace id from list_workspaces; omitted = active workspace.'),
      rootId: strProp('For kind=editor: root id from list_workspaces; omitted = active root.'),
      path: strProp('For kind=editor: root-relative POSIX path of the file to open.'),
    }),
    exec: (input) => openTab(input),
  },
  {
    name: 'activate_tab',
    group: 'tabs',
    write: true,
    description: 'Switch to (focus) an existing tab by id. Pass a tabId from list_tabs.',
    inputSchema: obj({ tabId: strProp('Tab id from list_tabs.') }, ['tabId']),
    exec: (input) => activateTabTool(input),
  },
  {
    name: 'navigate_tab',
    group: 'tabs',
    write: true,
    requiresWeb: true,
    description:
      'Navigate a web tab to a URL (or search text). Pass tabId (from list_tabs) to target a specific tab; omit it to use the active tab. A feature/blank target opens a fresh web tab for the navigation.',
    inputSchema: obj({
      url: strProp('URL or search text to load.'),
      tabId: strProp('Optional tab id from list_tabs; defaults to the active tab.'),
    }, ['url']),
    exec: (input) => navigateTab(input),
  },
  {
    name: 'close_tab',
    group: 'tabs',
    write: true,
    gated: true,
    description:
      'Close a tab by id (from list_tabs). Asks for approval — closing an editor tab with unsaved edits would discard them, so confirm before closing.',
    inputSchema: obj({ tabId: strProp('Tab id from list_tabs.') }, ['tabId']),
    exec: (input) => closeTabTool(input),
  },
  {
    name: 'list_workspaces',
    group: 'files',
    description:
      'List every open workspace, its roots, active root, and tabs grouped by workspace. Use this before reading files or tabs from a non-active workspace.',
    inputSchema: obj({}),
    exec: () => listWorkspaces(),
  },
  {
    name: 'list_workspace_files',
    group: 'files',
    description:
      'List indexed files for a specific workspace root. Pass workspaceId and rootId from list_workspaces; omit them to use the active workspace/root.',
    inputSchema: obj({
      workspaceId: strProp('Workspace id from list_workspaces; omitted = active workspace.'),
      rootId: strProp('Root id from list_workspaces; omitted = active root.'),
      glob: strProp('Optional glob; * and ** supported.'),
    }),
    exec: (input) => listWorkspaceFiles(input),
  },
  {
    name: 'read_workspace_file',
    group: 'files',
    description:
      'Read a UTF-8 file from a specific workspace root, including a non-active workspace. Pass workspaceId/rootId from list_workspaces plus the root-relative path. Large files are paged: read the next chunk with offset set to the line after the last one shown (the footer says when there is more).',
    inputSchema: obj({
      workspaceId: strProp('Workspace id from list_workspaces; omitted = active workspace.'),
      rootId: strProp('Root id from list_workspaces; omitted = active root.'),
      path: strProp('Root-relative POSIX path.'),
      offset: { type: 'integer', description: '1-based line number to start reading from (default 1).' },
      limit: { type: 'integer', description: 'Maximum lines to return (default 1500).' },
    }, ['path']),
    exec: (input) => readWorkspaceFile(input),
  },
  {
    name: 'read_page',
    group: 'browser',
    requiresWeb: true,
    description:
      "Read a web tab's visible, readable text (title + body innerText). Pass a tabId from list_tabs to read a non-active tab; omit it for the active page. Secret-scrubbed.",
    inputSchema: obj({ tabId: strProp('Optional web tab id (from list_tabs); defaults to the active tab.') }),
    exec: (input, ctx) => readPage(input, ctx),
  },
  {
    name: 'read_console',
    group: 'devtools',
    requiresWeb: true,
    description:
      "Read the live page's console output at ANY level (log/info/warning/error/debug) — what the app printed via console.*, captured always-on. Pass level to filter, omit for everything; pass tabId (from list_tabs) for a non-active tab. For uncaught ERRORS with source-file mapping, use get_console_errors instead. Secret-scrubbed.",
    inputSchema: obj({
      level: strProp("Filter: 'log' | 'info' | 'warning' | 'error' | 'debug', or omit/'all' for everything."),
      limit: { type: 'number', description: 'Max messages, newest (default 40, max 200).' },
      tabId: strProp('Optional web tab id (from list_tabs); defaults to the active tab.'),
    }),
    exec: (input, ctx) => readConsole(input, ctx),
  },
  {
    name: 'list_terminals',
    group: 'terminal',
    description: 'List the open integrated terminals with their ids and output size, so you can read a specific one.',
    inputSchema: obj({}),
    exec: () => listTerminals(),
  },
  {
    name: 'read_terminal',
    group: 'terminal',
    gated: true,
    description:
      'Read an integrated terminal\'s recent scrollback. Pass a terminalId (from list_terminals) for a specific one, or omit it for the most recent. ANSI-stripped, secret-scrubbed; requires approval.',
    inputSchema: obj({ terminalId: strProp('Optional terminal id (from list_terminals); defaults to the most recent.') }),
    exec: (input) => readTerminal(input),
  },
  {
    name: 'read_editor',
    group: 'tabs',
    description:
      "Read an open editor buffer, INCLUDING unsaved edits the user hasn't written to disk yet. Pass a workspace-relative path; omit it to list the open buffers. Falls back to the on-disk file when not open.",
    inputSchema: obj({
      workspaceId: strProp('Workspace id from list_workspaces; omitted = active workspace.'),
      rootId: strProp('Root id from list_workspaces; omitted = active root.'),
      path: strProp('Workspace-relative path of an open editor file; omit to list open buffers.'),
    }),
    exec: (input, ctx) => readEditor(input, ctx),
  },
  {
    name: 'read_explorer',
    group: 'files',
    description: "Read the file explorer's current state: workspace root, indexed file count, the selected file, and which folders are expanded (what the user is focused on).",
    inputSchema: obj({}),
    exec: () => readExplorer(),
  },
  {
    name: 'list_sessions',
    group: 'sessions',
    description: 'List previous AI Chat sessions (most recent first) with their id, title, model, and message count. Use to recall earlier conversations.',
    inputSchema: obj({ limit: { type: 'number', description: 'Max sessions (default 20).' } }),
    exec: (input) => listSessionsTool(input),
  },
  {
    name: 'read_session',
    group: 'sessions',
    description: 'Read a previous session\'s transcript (flattened to text) by id (from list_sessions). Secret-scrubbed.',
    inputSchema: obj({ id: strProp('Session id from list_sessions.') }, ['id']),
    exec: (input) => readSessionTool(input),
  },
  {
    name: 'delete_session',
    group: 'sessions',
    gated: true,
    write: true,
    description:
      'Delete a saved chat session by id (from list_sessions). Destructive and irreversible — asks for approval. Use to remove a session the user no longer wants kept.',
    inputSchema: obj({ id: strProp('Session id from list_sessions.') }, ['id']),
    exec: (input) => deleteSessionTool(input),
  },
  {
    name: 'list_memory',
    group: 'memory',
    description: 'List saved memory entries (durable notes that persist across sessions) with a preview of each.',
    inputSchema: obj({}),
    exec: () => listMemoryTool(),
  },
  {
    name: 'read_memory',
    group: 'memory',
    description: 'Read a memory entry\'s full text by name (from list_memory).',
    inputSchema: obj({ name: strProp('Memory entry name from list_memory.') }, ['name']),
    exec: (input) => readMemoryTool(input),
  },
  {
    name: 'write_memory',
    group: 'memory',
    write: true,
    description:
      'Save (or overwrite) a memory entry so you can recall it in later turns and sessions. Use for durable user facts/preferences/project context — not transient chatter. Name is a short kebab-case slug.',
    inputSchema: obj({ name: strProp('Short kebab-case slug, e.g. "deploy-process".'), body: strProp('The note (markdown).') }, ['name', 'body']),
    exec: (input) => writeMemoryTool(input),
  },
  {
    name: 'delete_memory',
    group: 'memory',
    gated: true,
    write: true,
    description:
      'Delete a memory entry by name (from list_memory). Destructive and irreversible — asks for approval. Use to remove an entry that is wrong or obsolete, or to free space near the entry cap.',
    inputSchema: obj({ name: strProp('Memory entry name from list_memory.') }, ['name']),
    exec: (input) => deleteMemoryTool(input),
  },
];
