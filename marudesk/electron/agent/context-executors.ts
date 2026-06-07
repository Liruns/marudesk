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
import type { TabKind } from '../../shared/browser';
import { activeRoot, rootById, workspaceById } from '../workspace-helpers';
import { getActiveTabId, getConsole, getTab, tabValues } from '../browser/state';
import { sendCdp } from '../browser/cdp';
import { getRecentTerminalOutput, getTerminalList, getTerminalOutput } from '../terminal';
import { getWorkspaceSnapshot, readFileWindow } from '../workspace';
import { pageLines } from './text-window';
import { getEditorMirror, getEditorMirrors, getExplorerMirror } from './context-cache';
import { deleteSession, listSessions, readSession } from './sessions-store';
import { deleteMemory, listMemory, readMemory, writeMemory } from './memory-store';
import type { ToolContext, ToolResult } from './tools';
import { ago, formatTabLine, resolveWebTab, tabUrl } from './context-helpers.ts';

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

export async function listTabs(): Promise<ToolResult> {
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

/* ── tab control (open / activate / navigate / close) ───────────────────── */

// Feature tabs the agent may open. 'web' and 'editor' take extra args; the rest
// are argument-free launchers. ('plugin' is intentionally excluded — it needs a
// panel descriptor only the renderer/plugin runtime owns.)
const OPENABLE_KINDS = new Set<TabKind>(['web', 'editor', 'terminal', 'home', 'settings', 'agent']);

export async function openTab(input: {
  kind?: unknown;
  url?: unknown;
  workspaceId?: unknown;
  rootId?: unknown;
  path?: unknown;
}): Promise<ToolResult> {
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const kindRaw = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
  const kind = (kindRaw || (url ? 'web' : '')) as TabKind | '';
  if (!kind) {
    throw new Error('open_tab requires "kind" (web|editor|terminal|home|settings|agent) or a "url"');
  }
  if (!OPENABLE_KINDS.has(kind as TabKind)) {
    throw new Error(`open_tab cannot open kind "${kind}" (use web|editor|terminal|home|settings|agent)`);
  }
  // Browser lifecycle + navigation/settings modules pull in heavy Electron APIs
  // (Menu, WebContentsView, …), so they're imported lazily here rather than at
  // module load — keeping the agent's static module graph importable under the
  // harness's minimal electron stub.
  const { createAndActivateTab } = await import('../browser/tabs');
  if (kind === 'editor') {
    const path = typeof input.path === 'string' ? input.path.trim() : '';
    if (!path) throw new Error('open_tab editor requires "path" (root-relative; see list_workspaces)');
    const { record, root } = resolveWorkspaceRoot(input);
    const rec = createAndActivateTab('editor', undefined, {
      workspaceId: record.id,
      editorFile: { workspaceId: record.id, rootId: root.id, path },
    });
    return {
      summary: `opened editor ${record.name}/${root.name}/${path}`,
      text: `Opened editor tab ${rec.id} for ${scrubText(path)}.`,
    };
  }
  if (kind === 'web') {
    let resolved = '';
    if (url) {
      const [{ resolveAddressBarInput, searchBaseFor }, { getSettingsSync }] = await Promise.all([
        import('../browser/url'),
        import('../settings'),
      ]);
      resolved = resolveAddressBarInput(url, searchBaseFor(getSettingsSync().browser.searchEngine));
    }
    const rec = createAndActivateTab('web', resolved || undefined);
    return {
      summary: 'opened web tab',
      text: `Opened web tab ${rec.id}${url ? ` → ${scrubText(url)}` : ' (blank)'}.`,
    };
  }
  const rec = createAndActivateTab(kind);
  return { summary: `opened ${kind} tab`, text: `Opened ${kind} tab ${rec.id}.` };
}

export async function activateTabTool(input: { tabId?: unknown }): Promise<ToolResult> {
  const id = typeof input.tabId === 'string' ? input.tabId.trim() : '';
  if (!id) throw new Error('activate_tab requires "tabId" (from list_tabs)');
  const rec = getTab(id);
  if (!rec) return { summary: `activate_tab ${id}`, text: `no tab with id ${id} (use list_tabs)`, isError: true };
  const { activateTab } = await import('../browser/tabs');
  activateTab(id);
  return { summary: `activated tab ${id}`, text: `Switched to the ${rec.kind} tab ${id}.` };
}

export async function navigateTab(input: { tabId?: unknown; url?: unknown }): Promise<ToolResult> {
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!url) throw new Error('navigate_tab requires "url"');
  const id = typeof input.tabId === 'string' ? input.tabId.trim() : '';
  if (id) {
    const rec = getTab(id);
    if (!rec) return { summary: `navigate_tab ${id}`, text: `no tab with id ${id} (use list_tabs)`, isError: true };
    const { activateTab } = await import('../browser/tabs');
    activateTab(id);
  }
  // navigateActive resolves the input (URL or search) and loads it in the active
  // web view, opening one if the (now-active) target is a feature tab.
  const { navigateActive } = await import('../browser/navigation');
  await navigateActive(url);
  return { summary: `navigated → ${scrubText(url)}`, text: `Navigated to ${scrubText(url)}.` };
}

export async function closeTabTool(input: { tabId?: unknown }): Promise<ToolResult> {
  const id = typeof input.tabId === 'string' ? input.tabId.trim() : '';
  if (!id) throw new Error('close_tab requires "tabId" (from list_tabs)');
  const rec = getTab(id);
  if (!rec) return { summary: `close_tab ${id}`, text: `no tab with id ${id} (use list_tabs)`, isError: true };
  const { closeTab } = await import('../browser/tabs');
  const ok = closeTab(id);
  return ok
    ? { summary: `closed tab ${id}`, text: `Closed the ${rec.kind} tab ${id}.` }
    : { summary: `close_tab ${id} (failed)`, text: `could not close tab ${id}`, isError: true };
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

export async function listWorkspaces(): Promise<ToolResult> {
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

export async function listWorkspaceFiles(input: {
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

export async function readWorkspaceFile(input: {
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
  // Report touchedPaths so the loop lazily injects this directory's not-yet-seen
  // AGENTS.md (audit H7) — same as read_file. Only when this read targets the
  // ACTIVE workspace, since the loop walks touchedPaths against the active root;
  // a non-active-workspace read must not pull the active workspace's nested
  // instructions for a path that lives elsewhere.
  const onActiveWorkspace = record.id === getWorkspaceSnapshot().activeWorkspaceId;
  return {
    summary: `read ${record.name}/${root.name}/${filePath}${view.ranged ? ` (lines ${view.firstLine}-${view.lastLine})` : ''}`,
    text: view.text,
    ...(onActiveWorkspace ? { touchedPaths: [filePath] } : {}),
  };
}

export async function readPage(input: { tabId?: unknown }, ctx: ToolContext): Promise<ToolResult> {
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

export async function readConsole(
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

export async function listTerminals(): Promise<ToolResult> {
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

export async function readTerminal(input: { terminalId?: unknown }): Promise<ToolResult> {
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

export async function readEditor(
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

export async function readExplorer(): Promise<ToolResult> {
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

export async function listSessionsTool(input: { limit?: unknown }): Promise<ToolResult> {
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

export async function readSessionTool(input: { id?: unknown }): Promise<ToolResult> {
  const id = typeof input.id === 'string' ? input.id : '';
  if (!id) throw new Error('read_session requires "id" (from list_sessions)');
  const rec = await readSession(id);
  if (!rec) return { summary: `read_session ${id}`, text: `no saved session with id ${id}`, isError: true };
  const head = `"${rec.title}" — ${rec.model} (${rec.provider}), ${rec.messageCount} messages, ${ago(rec.createdAt)}`;
  return { summary: `session "${scrubText(rec.title)}"`, text: clip(scrubText(`${head}\n\n${flattenSession(rec)}`)) };
}

export async function deleteSessionTool(input: { id?: unknown }): Promise<ToolResult> {
  const id = typeof input.id === 'string' ? input.id : '';
  if (!id) throw new Error('delete_session requires "id" (from list_sessions)');
  const rec = await readSession(id);
  if (!rec) return { summary: `delete_session ${id}`, text: `no saved session with id ${id} (use list_sessions)`, isError: true };
  const ok = await deleteSession(id);
  if (!ok) return { summary: `delete_session ${id} (failed)`, text: `could not delete session ${id}`, isError: true };
  return { summary: `deleted session "${scrubText(rec.title)}"`, text: `Deleted session ${id} ("${scrubText(rec.title)}"). It will no longer appear in list_sessions.` };
}

/* ── memory ─────────────────────────────────────────────────────────────── */

export async function listMemoryTool(): Promise<ToolResult> {
  const rows = await listMemory();
  if (rows.length === 0) {
    return { summary: 'memory (empty)', text: 'No memory entries yet. Use write_memory to remember something across sessions.' };
  }
  const lines = rows.map((r) => `- ${r.name} (${ago(r.updatedAt)}): ${scrubText(r.preview)}`);
  return { summary: `${rows.length} memor${rows.length === 1 ? 'y' : 'ies'}`, text: clip(`${lines.join('\n')}\n\nRead one with read_memory (pass name).`) };
}

export async function readMemoryTool(input: { name?: unknown }): Promise<ToolResult> {
  const name = typeof input.name === 'string' ? input.name : '';
  if (!name) throw new Error('read_memory requires "name" (from list_memory)');
  const entry = await readMemory(name);
  if (!entry) return { summary: `read_memory ${name}`, text: `no memory entry named "${name}" (use list_memory)`, isError: true };
  return { summary: `memory ${entry.name}`, text: clip(scrubText(entry.body || '(empty)')) };
}

export async function writeMemoryTool(input: { name?: unknown; body?: unknown }): Promise<ToolResult> {
  const name = typeof input.name === 'string' ? input.name : '';
  const body = typeof input.body === 'string' ? input.body : '';
  if (!name) throw new Error('write_memory requires "name"');
  if (!body.trim()) throw new Error('write_memory requires a non-empty "body"');
  const res = await writeMemory(name, body);
  if (!res.ok) return { summary: `write_memory ${res.name} (failed)`, text: res.reason ?? 'could not write memory', isError: true };
  return { summary: `remembered "${res.name}"`, text: `Saved memory "${res.name}". Recall it later with read_memory.` };
}

export async function deleteMemoryTool(input: { name?: unknown }): Promise<ToolResult> {
  const name = typeof input.name === 'string' ? input.name : '';
  if (!name) throw new Error('delete_memory requires "name" (from list_memory)');
  const entry = await readMemory(name);
  if (!entry) return { summary: `delete_memory ${name}`, text: `no memory entry named "${name}" (use list_memory)`, isError: true };
  const ok = await deleteMemory(name);
  if (!ok) return { summary: `delete_memory ${entry.name} (failed)`, text: `could not delete memory "${entry.name}"`, isError: true };
  return { summary: `deleted memory "${entry.name}"`, text: `Deleted memory "${entry.name}". It will no longer appear in list_memory.` };
}

