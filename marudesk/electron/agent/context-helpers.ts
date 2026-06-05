import { scrubText } from '../../shared/scrub';
import type { WorkspaceRecord } from '../../shared/workspace';
import { rootById, workspaceById } from '../workspace-helpers';
import { getTab, type TabRecord } from '../browser/state';
import type { ToolContext } from './tools';

/**
 * Tab/workspace label + resolution helpers shared by the context-MCP executors
 * (context-executors.ts). Pure formatting + tab lookup; no executor logic.
 */

export function ago(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

/** Resolve a web tab to target: the given id, else the turn's active tab. */
export function resolveWebTab(tabId: unknown, ctx: ToolContext): TabRecord {
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

export function tabUrl(rec: TabRecord): string {
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

export function formatTabLine(
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
