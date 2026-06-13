import { type BrowserNativeMenuItem, type TabKind } from '../../shared/browser';
import { isSafePanelPath, isValidPluginId } from '../../shared/plugin';
import type { WorkspaceFileRef, WorkspaceId } from '../../shared/workspace';
import { bool, num, obj, str } from '../ipc/validate';
import { isTabKind, type Bounds } from './state';

/**
 * Pure payload parsers/validators for the browser IPC handlers — coerce the
 * untrusted renderer payloads (bounds, tab specs, plugin panels, native-menu
 * items) into typed shapes. Split out of handlers.ts so it holds the wiring.
 */

export function toBounds(v: unknown, field = 'bounds'): Bounds {
  const o = obj(v, field);
  return {
    x: num(o.x, `${field}.x`),
    y: num(o.y, `${field}.y`),
    width: num(o.width, `${field}.width`),
    height: num(o.height, `${field}.height`),
  };
}

/**
 * Resolve a tabs-new / tabs-replace payload to a { kind, url } pair. Accepts a
 * bare url string (legacy = web navigation) or { kind?, url?, path? }. A url
 * with no kind means web; an editor tab carries a workspace-relative `path`
 * instead of a url. Untrusted renderer input — the kind is validated by
 * isTabKind and the url/path are passed through to createTab (which re-resolves
 * the url and re-validates any file path on read/write).
 */
export function parseWorkspaceFile(value: unknown): WorkspaceFileRef | undefined {
  if (value === undefined) return undefined;
  const p = obj(value, 'file');
  return {
    workspaceId: str(p.workspaceId, 'file.workspaceId'),
    rootId: str(p.rootId, 'file.rootId'),
    path: str(p.path, 'file.path'),
  };
}

export function parseTabSpec(payload: unknown): {
  kind: TabKind;
  url: string | undefined;
  workspaceId: WorkspaceId | undefined;
  editorFile: WorkspaceFileRef | undefined;
  pluginPanel: { id: string; entry: string } | undefined;
  terminalProfile: 'agent-cli' | undefined;
  devtoolsTargetTabId: string | undefined;
} {
  let kind: TabKind = 'home';
  let url: string | undefined;
  let workspaceId: WorkspaceId | undefined;
  let editorFile: WorkspaceFileRef | undefined;
  let pluginPanel: { id: string; entry: string } | undefined;
  let terminalProfile: 'agent-cli' | undefined;
  let devtoolsTargetTabId: string | undefined;
  if (typeof payload === 'string') {
    return { kind: 'web', url: payload, workspaceId, editorFile, pluginPanel, terminalProfile, devtoolsTargetTabId };
  }
  if (payload && typeof payload === 'object') {
    const p = payload as {
      kind?: unknown;
      url?: unknown;
      path?: unknown;
      pluginPanel?: unknown;
      terminalProfile?: unknown;
      devtoolsTargetTabId?: unknown;
    };
    if (isTabKind(p.kind)) kind = p.kind;
    else if (typeof p.url === 'string') kind = 'web';
    if (typeof p.url === 'string') url = p.url;
    else if (kind === 'editor' && typeof p.path === 'string') url = p.path;
    if ('workspaceId' in p && typeof p.workspaceId === 'string') {
      workspaceId = p.workspaceId;
    }
    editorFile = parseWorkspaceFile('file' in p ? p.file : undefined);
    if (kind === 'editor' && editorFile) url = editorFile.path;
    if (kind === 'plugin') pluginPanel = parsePluginPanel(p.pluginPanel);
    // Untrusted renderer input: only the known profile name passes through.
    if (kind === 'terminal' && p.terminalProfile === 'agent-cli') terminalProfile = 'agent-cli';
    if (kind === 'devtools' && typeof p.devtoolsTargetTabId === 'string') devtoolsTargetTabId = p.devtoolsTargetTabId;
  }
  return { kind, url, workspaceId, editorFile, pluginPanel, terminalProfile, devtoolsTargetTabId };
}

/** Validate the renderer-supplied plugin-panel ref (untrusted): id slug + safe entry. */
export function parsePluginPanel(value: unknown): { id: string; entry: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { id?: unknown; entry?: unknown };
  if (!isValidPluginId(v.id) || !isSafePanelPath(v.entry)) return undefined;
  return { id: v.id, entry: v.entry };
}

export function parseNativeMenuItem(value: unknown, index: number): BrowserNativeMenuItem {
  const v = obj(value, `items[${index}]`);
  if (v.type === 'separator') return { type: 'separator' };
  return {
    id: str(v.id, `items[${index}].id`),
    label: str(v.label, `items[${index}].label`),
    enabled: v.enabled === undefined ? undefined : bool(v.enabled, `items[${index}].enabled`),
    shortcut: v.shortcut === undefined ? undefined : str(v.shortcut, `items[${index}].shortcut`),
  };
}

