import { scrubText } from '../../shared/scrub';
import { globToRegExp } from '../../shared/glob';
import { SECRET_FILE_PATTERN as SECRET_FILE } from '../../shared/secret-files';
import { clipText as clip, MAX_TOOL_TEXT as MAX_TEXT } from '../../shared/text-clip';
import {
  workspaceFileKey,
  type WorkspaceRecord,
  type WorkspaceRootSummary,
} from '../../shared/workspace';
import type { SessionRecord } from '../../shared/context';
import { activeRoot, rootById, workspaceById } from '../workspace-helpers';
import { getActiveTabId, getConsole, getTab, tabValues, type TabRecord } from '../browser/state';
import { sendCdp } from '../browser/cdp';
import { getRecentTerminalOutput, getTerminalList, getTerminalOutput } from '../terminal';
import { getWorkspaceSnapshot, readFileWindow } from '../workspace';
import { pageLines } from './text-window';
import { getEditorMirror, getEditorMirrors, getExplorerMirror } from './context-cache';
import { deleteSession, listSessions, readSession } from './sessions-store';
import { deleteMemory, listMemory, readMemory, writeMemory } from './memory-store';
import type { McpTool, ToolContext, ToolResult } from './tools';

/**
 * The NEW context sources for the built-in MCP (docs/context-mcp-design §2). These
 * let the model pull, on demand, from surfaces the original tool set didn't reach:
 * ANY open browser tab's text (not just the active one), the list of open tabs,
 * every terminal (by id), open editor buffers incl. unsaved edits, the file
 * explorer's state, previous chat sessions, and a persistent memory.
 *
 * Same guarantees as tools.ts: read-only except `write_memory`, every
 * page/terminal/editor string scrubbed at egress, results bounded. Executors may
 * throw for hard errors — the registry (mcp.ts) catches and renders them as a
 * tool error, exactly like the original executor path.
 */


/** A short relative "when" label (e.g. "3m ago", "2h ago", "5d ago"). */
function ago(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

/** Resolve a web tab to target: the given id, else the turn's active tab. */
function resolveWebTab(tabId: unknown, ctx: ToolContext): TabRecord {
  const id = typeof tabId === 'string' && tabId ? tabId : ctx.tabId;
  if (!id) throw new Error('no web tab — open a page, or pass a tabId from list_tabs');
  const rec = getTab(id);
  if (!rec || rec.kind !== 'web' || !rec.view) {
    throw new Error(`tab ${id} is not a live web page (use list_tabs to see web tabs)`);
  }
  if (rec.chromeDevtoolsOpen) {
    throw new Error(`tab ${id} has Chromium DevTools open, which holds the CDP client — close it to read this page`);
  }
  return rec;
}

function tabUrl(rec: TabRecord): string {
  try {
    return rec.view!.webContents.getURL();
  } catch {
    return '';
  }
}

function tabWorkspaceScope(
  rec: TabRecord,
  workspaces: readonly WorkspaceRecord[],
): string {
  const record = workspaceById(workspaces, rec.workspaceId);
  return record ? ` @ ${record.name}` : '';
}

function editorTabLabel(
  rec: TabRecord,
  workspaces: readonly WorkspaceRecord[],
): string {
  if (rec.editorFile) {
    const record = workspaceById(workspaces, rec.editorFile.workspaceId);
    const root = record ? rootById(record, rec.editorFile.rootId) : null;
    return `${record?.name ?? rec.editorFile.workspaceId}/${root?.name ?? rec.editorFile.rootId}/${rec.editorFile.path}`;
  }
  return rec.filePath ?? '(untitled buffer)';
}

function formatTabLine(
  rec: TabRecord,
  activeTabId: string | null,
  workspaces: readonly WorkspaceRecord[],
): string {
  const mark = rec.id === activeTabId ? '*' : ' ';
  const scope = tabWorkspaceScope(rec, workspaces);
  if (rec.kind === 'web') {
    let title = '';
    try {
      title = rec.view?.webContents.getTitle() ?? '';
    } catch {
      /* destroyed */
    }
    const url = tabUrl(rec);
    return `${mark} [web${scope}] ${rec.id} - ${scrubText(title) || '(untitled)'}  ${scrubText(url)}`.trimEnd();
  }
  if (rec.kind === 'editor') {
    return `${mark} [editor${scope}] ${rec.id} - ${editorTabLabel(rec, workspaces)}`;
  }
  return `${mark} [${rec.kind}${scope}] ${rec.id}`;
}

/* ── browser / tabs ─────────────────────────────────────────────────────── */

async function listTabs(): Promise<ToolResult> {
  const active = getActiveTabId();
  const tabs = tabValues();
  if (tabs.length === 0) return { summary: 'no tabs', text: 'No tabs are open.' };
  const lines = tabs.map((t) => {
    const mark = t.id === active ? '*' : ' ';
    if (t.kind === 'web') {
      let title = '';
      try {
        title = t.view?.webContents.getTitle() ?? '';
      } catch {
        /* destroyed */
      }
      const url = tabUrl(t);
      return `${mark} [web] ${t.id} — ${scrubText(title) || '(untitled)'}  ${scrubText(url)}`.trimEnd();
    }
    if (t.kind === 'editor') return `${mark} [editor] ${t.id} — ${t.filePath ?? '(untitled buffer)'}`;
    return `${mark} [${t.kind}] ${t.id}`;
  });
  const hint =
    'Read content per kind: web → read_page / query_dom, editor → read_editor, terminal → read_terminal (list_terminals for ids). "*" = active tab.';
  return {
    summary: `${tabs.length} tab${tabs.length === 1 ? '' : 's'}`,
    text: clip(`${lines.join('\n')}\n\n${hint}`),
  };
}

function resolveWorkspaceRoot(input: {
  workspaceId?: unknown;
  rootId?: unknown;
}): { record: WorkspaceRecord; root: WorkspaceRootSummary } {
  const snapshot = getWorkspaceSnapshot();
  const workspaceId =
    typeof input.workspaceId === 'string' && input.workspaceId
      ? input.workspaceId
      : snapshot.activeWorkspaceId ?? snapshot.focusedWorkspaceId ?? '';
  const record = workspaceById(snapshot.workspaces, workspaceId);
  if (!record) throw new Error('workspaceId is required; use list_workspaces to find one');
  const rootId =
    typeof input.rootId === 'string' && input.rootId
      ? input.rootId
      : record.activeRootId ?? record.roots[0]?.id ?? '';
  const root = rootById(record, rootId);
  if (!root) throw new Error(`root not found in workspace ${record.name}; use list_workspaces`);
  return { record, root };
}

async function listWorkspaces(): Promise<ToolResult> {
  const snapshot = getWorkspaceSnapshot();
  if (snapshot.workspaces.length === 0) {
    return { summary: 'no workspaces', text: 'No workspaces are open.' };
  }
  const activeTabId = getActiveTabId();
  const tabs = tabValues();
  const lines: string[] = [];
  for (const workspace of snapshot.workspaces) {
    const mark = workspace.id === snapshot.activeWorkspaceId ? '*' : ' ';
    const root = activeRoot(workspace);
    lines.push(`${mark} ${workspace.name}  workspaceId=${workspace.id}`);
    lines.push(`  activeRootId=${root?.id ?? '(none)'}${root ? ` (${root.name}, ${root.files.length} files)` : ''}`);
    for (const entry of workspace.roots) {
      lines.push(`  root ${entry.name}: rootId=${entry.id}, files=${entry.files.length}, path=${scrubText(entry.root)}`);
    }
    const scopedTabs = tabs.filter((tab) => tab.workspaceId === workspace.id);
    if (scopedTabs.length > 0) {
      lines.push('  tabs:');
      for (const tab of scopedTabs) {
        lines.push(`    ${formatTabLine(tab, activeTabId, snapshot.workspaces)}`);
      }
    }
  }
  return {
    summary: `${snapshot.workspaces.length} workspace${snapshot.workspaces.length === 1 ? '' : 's'}`,
    text: clip(`${lines.join('\n')}\n\nUse list_workspace_files/read_workspace_file with workspaceId and rootId to inspect a non-active workspace.`),
  };
}

async function listWorkspaceFiles(input: {
  workspaceId?: unknown;
  rootId?: unknown;
  glob?: unknown;
}): Promise<ToolResult> {
  const { record, root } = resolveWorkspaceRoot(input);
  const glob = typeof input.glob === 'string' && input.glob.trim() ? input.glob.trim() : '';
  const re = glob ? globToRegExp(glob) : null;
  const matched = root.files
    .map((file) => file.path)
    .filter((filePath) => (re ? re.test(filePath) : true))
    .slice(0, 300);
  const more = root.files.length > matched.length ? `\n(${root.files.length} total)` : '';
  return {
    summary: `${record.name}/${root.name} - ${matched.length} file${matched.length === 1 ? '' : 's'}`,
    text: matched.length ? clip(matched.join('\n') + more) : '(no files)',
  };
}

async function readWorkspaceFile(input: {
  workspaceId?: unknown;
  rootId?: unknown;
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
}): Promise<ToolResult> {
  const { record, root } = resolveWorkspaceRoot(input);
  const filePath = typeof input.path === 'string' ? input.path : '';
  if (!filePath) throw new Error('read_workspace_file requires "path"');
  if (SECRET_FILE.test(filePath)) {
    return {
      summary: `read ${record.name}/${root.name}/${filePath} (blocked)`,
      text: `Refused: "${filePath}" looks like a credentials file. Ask the user to share only the specific values needed.`,
      isError: true,
    };
  }
  // Same line-addressable read as read_file: full document up to the agent
  // limit (clean line boundaries — no split multibyte chars), paged for display.
  const { content, truncated } = await readFileWindow(root.root, filePath);
  const view = pageLines(scrubText(content), {
    offset: input.offset,
    limit: input.limit,
    truncated,
  });
  return {
    summary: `read ${record.name}/${root.name}/${filePath}${view.ranged ? ` (lines ${view.firstLine}-${view.lastLine})` : ''}`,
    text: view.text,
  };
}

async function readPage(input: { tabId?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  const rec = resolveWebTab(input.tabId, ctx);
  // Visible, readable text — title + body.innerText (what a human sees), bounded
  // in-page before it crosses the wire so a huge DOM can't blow the result.
  const expr = `(() => {
    const t = document.title || '';
    const b = document.body ? document.body.innerText : '';
    return (t ? t + "\\n\\n" : '') + (b || '').slice(0, ${MAX_TEXT + 2000});
  })()`;
  const res = (await sendCdp(rec, 'Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    timeout: 5_000,
  })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
  if (res?.exceptionDetails) {
    return { summary: 'read_page (failed)', text: `could not read the page — ${scrubText(res.exceptionDetails.text ?? 'evaluation threw')}`, isError: true };
  }
  const text = typeof res?.result?.value === 'string' ? res.result.value : '';
  const url = tabUrl(rec);
  if (!text.trim()) return { summary: `read_page @ ${url}`, text: 'The page has no visible text yet (still loading or empty).' };
  return { summary: `read_page @ ${scrubText(url)}`, text: clip(scrubText(text)) };
}

/* ── devtools console (all levels — M2) ─────────────────────────────────── */

/**
 * Resolve a web tab id for a BUFFER read. Unlike resolveWebTab (which targets the
 * live CDP client and rejects a tab with Chromium DevTools open), the always-on
 * console buffer is valid regardless of who holds the live client.
 */
function resolveWebTabId(tabId: unknown, ctx: ToolContext): string {
  const id = typeof tabId === 'string' && tabId ? tabId : ctx.tabId;
  if (!id) throw new Error('no web tab — open a page, or pass a tabId from list_tabs');
  const rec = getTab(id);
  if (!rec || rec.kind !== 'web') {
    throw new Error(`tab ${id} is not a web page (use list_tabs to see web tabs)`);
  }
  return id;
}

const CONSOLE_LEVELS = new Set(['log', 'info', 'warning', 'error', 'debug']);

async function readConsole(
  input: { tabId?: unknown; level?: unknown; limit?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const id = resolveWebTabId(input.tabId, ctx);
  const raw = typeof input.level === 'string' ? input.level.toLowerCase() : 'all';
  const level = raw === 'warn' ? 'warning' : raw;
  if (level !== 'all' && !CONSOLE_LEVELS.has(level)) {
    throw new Error(`level must be all|log|info|warning|error|debug (got "${raw}")`);
  }
  const limit =
    typeof input.limit === 'number' ? Math.min(Math.max(1, Math.round(input.limit)), 200) : 40;
  let msgs = getConsole(id);
  if (level !== 'all') msgs = msgs.filter((m) => m.level === level);
  msgs = msgs.slice(-limit);
  if (msgs.length === 0) {
    return {
      summary: `console (${level === 'all' ? 'empty' : 'no ' + level})`,
      text:
        level === 'all'
          ? 'No console output captured yet — the page may not have logged anything (reload to repopulate). For uncaught errors, try get_console_errors.'
          : `No ${level}-level console messages captured.`,
    };
  }
  const lines = msgs.map((m) => `[${m.level}] ${m.text}`);
  return {
    summary: `console → ${msgs.length} message${msgs.length === 1 ? '' : 's'}${level === 'all' ? '' : ` (${level})`}`,
    text: clip(scrubText(lines.join('\n'))),
  };
}

/* ── terminals ──────────────────────────────────────────────────────────── */

async function listTerminals(): Promise<ToolResult> {
  const list = getTerminalList();
  if (list.length === 0) return { summary: 'no terminals', text: 'No terminal is open.' };
  const lines = list.map(
    (t, i) => `${i + 1}. ${t.id} — ${t.lines} line${t.lines === 1 ? '' : 's'}, ${t.bytes} bytes`,
  );
  return {
    summary: `${list.length} terminal${list.length === 1 ? '' : 's'}`,
    text: `${lines.join('\n')}\n\nRead one with read_terminal (pass terminalId), or omit it for the most recent.`,
  };
}

async function readTerminal(input: { terminalId?: unknown }): Promise<ToolResult> {
  const id = typeof input.terminalId === 'string' && input.terminalId ? input.terminalId : '';
  if (id) {
    const res = getTerminalOutput(id, 8000);
    if (!res) return { summary: 'read_terminal', text: `no live terminal with id ${id} (use list_terminals)`, isError: true };
    if (!res.output.trim()) return { summary: `terminal ${id} (empty)`, text: 'That terminal has produced no output yet.' };
    return { summary: `terminal ${id}`, text: clip(scrubText(res.output)) };
  }
  const recent = getRecentTerminalOutput(8000);
  if (!recent) return { summary: 'no terminal', text: 'No terminal session is open.' };
  if (!recent.output.trim()) return { summary: 'terminal (no output)', text: 'The most recent terminal has produced no output yet.' };
  const note = recent.count > 1 ? ` (most recent of ${recent.count}; list_terminals for the rest)` : '';
  return { summary: `terminal output${note}`, text: clip(scrubText(recent.output)) };
}

/* ── editor buffers / explorer (from the renderer mirror) ───────────────── */

type EditorReadTarget = {
  readonly displayPath: string;
  readonly mirrorPath: string;
  readonly diskRoot?: string;
  readonly diskPath: string;
};

function editorReadTarget(input: {
  workspaceId?: unknown;
  rootId?: unknown;
  path?: unknown;
}): EditorReadTarget | null {
  const p = typeof input.path === 'string' ? input.path.trim() : '';
  if (!p) return null;
  const usesWorkspaceScope =
    typeof input.workspaceId === 'string' || typeof input.rootId === 'string';
  if (!usesWorkspaceScope) {
    return { displayPath: p, mirrorPath: p, diskPath: p };
  }
  const snapshot = getWorkspaceSnapshot();
  const workspaceId =
    typeof input.workspaceId === 'string' && input.workspaceId
      ? input.workspaceId
      : snapshot.activeWorkspaceId ?? snapshot.focusedWorkspaceId ?? '';
  const rootId = typeof input.rootId === 'string' && input.rootId ? input.rootId : '';
  if (!workspaceId) {
    throw new Error('workspaceId is required; use list_workspaces to find one');
  }
  if (!rootId) {
    const { record, root } = resolveWorkspaceRoot(input);
    return {
      displayPath: `${record.name}/${root.name}/${p}`,
      mirrorPath: workspaceFileKey({
        workspaceId: record.id,
        rootId: root.id,
        path: p,
      }),
      diskRoot: root.root,
      diskPath: p,
    };
  }
  const record = workspaceById(snapshot.workspaces, workspaceId);
  const root = record ? rootById(record, rootId) : null;
  return {
    displayPath: `${record?.name ?? workspaceId}/${root?.name ?? rootId}/${p}`,
    mirrorPath: workspaceFileKey({
      workspaceId,
      rootId,
      path: p,
    }),
    diskRoot: root?.root,
    diskPath: p,
  };
}

async function readEditor(
  input: { workspaceId?: unknown; rootId?: unknown; path?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = editorReadTarget(input);
  if (!target) {
    const mirrors = getEditorMirrors();
    if (mirrors.length === 0) {
      return { summary: 'read_editor', text: 'No editor buffers are open. Pass a path to read one (or use list_tabs).' };
    }
    const lines = mirrors.map((e) => `- ${e.path}${e.dirty ? '  (unsaved edits)' : ''}`);
    return { summary: `${mirrors.length} open editor${mirrors.length === 1 ? '' : 's'}`, text: lines.join('\n') };
  }
  const mir = getEditorMirror(target.mirrorPath);
  if (mir) {
    const head = mir.dirty ? `(open in editor — UNSAVED edits${mir.truncated ? ', truncated' : ''})` : '(open in editor — saved)';
    return { summary: `editor ${target.displayPath}${mir.dirty ? ' *' : ''}`, text: clip(scrubText(`${head}\n\n${mir.content}`)) };
  }
  // Not open in the editor — fall back to the on-disk content if there's a workspace.
  const diskRoot = target.diskRoot ?? ctx.ws?.root;
  if (diskRoot) {
    if (SECRET_FILE.test(target.diskPath)) {
      return {
        summary: `editor ${target.displayPath} (blocked)`,
        text: `Refused: "${target.displayPath}" looks like a credentials file. Ask the user to share only the specific values needed.`,
        isError: true,
      };
    }
    try {
      const { content } = await readFileWindow(diskRoot, target.diskPath);
      return { summary: `editor ${target.displayPath} (on disk)`, text: clip(scrubText(`(not open in the editor; reading the saved file)\n\n${content}`)) };
    } catch {
      /* fall through to the not-found message */
    }
  }
  return { summary: `editor ${target.displayPath}`, text: `"${target.displayPath}" isn't open in the editor and couldn't be read from disk.`, isError: true };
}

async function readExplorer(): Promise<ToolResult> {
  const ex = getExplorerMirror();
  if (!ex.root && ex.expandedDirs.length === 0 && !ex.selectedPath) {
    return { summary: 'explorer (empty)', text: 'No workspace folder is open in the file explorer.' };
  }
  const lines = [
    `root: ${ex.root ?? '(none)'}`,
    ex.fileCount != null ? `indexed files: ${ex.fileCount}` : '',
    `selected: ${ex.selectedPath ?? '(none)'}`,
    `expanded folders (${ex.expandedDirs.length}):`,
    ...ex.expandedDirs.slice(0, 60).map((d) => `  ${d || '/'}`),
  ].filter(Boolean);
  return { summary: 'explorer state', text: clip(lines.join('\n')) };
}

/* ── sessions (previous chats) ──────────────────────────────────────────── */

async function listSessionsTool(input: { limit?: unknown }): Promise<ToolResult> {
  const limit = typeof input.limit === 'number' ? input.limit : 20;
  const rows = await listSessions(limit);
  if (rows.length === 0) return { summary: 'no past sessions', text: 'There are no saved chat sessions yet.' };
  const lines = rows.map(
    (r) => `- ${r.id} — "${scrubText(r.title)}" (${r.messageCount} msgs, ${r.model}, ${ago(r.updatedAt)})`,
  );
  return {
    summary: `${rows.length} session${rows.length === 1 ? '' : 's'}`,
    text: clip(`${lines.join('\n')}\n\nRead one with read_session (pass id).`),
  };
}

function flattenSession(rec: SessionRecord): string {
  return rec.messages
    .map((m) => {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => (p.type === 'text' ? p.text : '')).join('');
      const tools = m.parts
        .filter((p) => p.type === 'tool')
        .map((p) => (p.type === 'tool' ? `  · ${p.call.summary ?? p.call.name}` : ''))
        .filter(Boolean)
        .join('\n');
      const head = m.role === 'user' ? 'User' : 'Assistant';
      return `${head}: ${text.trim()}${tools ? `\n${tools}` : ''}`.trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

async function readSessionTool(input: { id?: unknown }): Promise<ToolResult> {
  const id = typeof input.id === 'string' ? input.id : '';
  if (!id) throw new Error('read_session requires "id" (from list_sessions)');
  const rec = await readSession(id);
  if (!rec) return { summary: `read_session ${id}`, text: `no saved session with id ${id}`, isError: true };
  const head = `"${rec.title}" — ${rec.model} (${rec.provider}), ${rec.messageCount} messages, ${ago(rec.createdAt)}`;
  return { summary: `session "${scrubText(rec.title)}"`, text: clip(scrubText(`${head}\n\n${flattenSession(rec)}`)) };
}

async function deleteSessionTool(input: { id?: unknown }): Promise<ToolResult> {
  const id = typeof input.id === 'string' ? input.id : '';
  if (!id) throw new Error('delete_session requires "id" (from list_sessions)');
  const rec = await readSession(id);
  if (!rec) return { summary: `delete_session ${id}`, text: `no saved session with id ${id} (use list_sessions)`, isError: true };
  const ok = await deleteSession(id);
  if (!ok) return { summary: `delete_session ${id} (failed)`, text: `could not delete session ${id}`, isError: true };
  return { summary: `deleted session "${scrubText(rec.title)}"`, text: `Deleted session ${id} ("${scrubText(rec.title)}"). It will no longer appear in list_sessions.` };
}

/* ── memory ─────────────────────────────────────────────────────────────── */

async function listMemoryTool(): Promise<ToolResult> {
  const rows = await listMemory();
  if (rows.length === 0) {
    return { summary: 'memory (empty)', text: 'No memory entries yet. Use write_memory to remember something across sessions.' };
  }
  const lines = rows.map((r) => `- ${r.name} (${ago(r.updatedAt)}): ${scrubText(r.preview)}`);
  return { summary: `${rows.length} memor${rows.length === 1 ? 'y' : 'ies'}`, text: clip(`${lines.join('\n')}\n\nRead one with read_memory (pass name).`) };
}

async function readMemoryTool(input: { name?: unknown }): Promise<ToolResult> {
  const name = typeof input.name === 'string' ? input.name : '';
  if (!name) throw new Error('read_memory requires "name" (from list_memory)');
  const entry = await readMemory(name);
  if (!entry) return { summary: `read_memory ${name}`, text: `no memory entry named "${name}" (use list_memory)`, isError: true };
  return { summary: `memory ${entry.name}`, text: clip(scrubText(entry.body || '(empty)')) };
}

async function writeMemoryTool(input: { name?: unknown; body?: unknown }): Promise<ToolResult> {
  const name = typeof input.name === 'string' ? input.name : '';
  const body = typeof input.body === 'string' ? input.body : '';
  if (!name) throw new Error('write_memory requires "name"');
  if (!body.trim()) throw new Error('write_memory requires a non-empty "body"');
  const res = await writeMemory(name, body);
  if (!res.ok) return { summary: `write_memory ${res.name} (failed)`, text: res.reason ?? 'could not write memory', isError: true };
  return { summary: `remembered "${res.name}"`, text: `Saved memory "${res.name}". Recall it later with read_memory.` };
}

async function deleteMemoryTool(input: { name?: unknown }): Promise<ToolResult> {
  const name = typeof input.name === 'string' ? input.name : '';
  if (!name) throw new Error('delete_memory requires "name" (from list_memory)');
  const entry = await readMemory(name);
  if (!entry) return { summary: `delete_memory ${name}`, text: `no memory entry named "${name}" (use list_memory)`, isError: true };
  const ok = await deleteMemory(name);
  if (!ok) return { summary: `delete_memory ${entry.name} (failed)`, text: `could not delete memory "${entry.name}"`, isError: true };
  return { summary: `deleted memory "${entry.name}"`, text: `Deleted memory "${entry.name}". It will no longer appear in list_memory.` };
}

/* ── descriptors ────────────────────────────────────────────────────────── */

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
