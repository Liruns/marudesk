import type { WorkspaceId, WorkspacePaneId } from '../../../shared/workspace';

export type WorkspaceSplitDir = 'row' | 'col';

export type WorkspaceLeafNode = {
  readonly type: 'leaf';
  readonly id: WorkspacePaneId;
  readonly workspaceId: WorkspaceId;
};

export type WorkspaceSplitNode = {
  readonly type: 'split';
  readonly id: WorkspacePaneId;
  readonly dir: WorkspaceSplitDir;
  readonly ratio: number;
  readonly a: WorkspaceLayoutNode;
  readonly b: WorkspaceLayoutNode;
};

export type WorkspaceLayoutNode = WorkspaceLeafNode | WorkspaceSplitNode;

const MIN_RATIO = 0.12;
const MAX_RATIO = 0.88;

let paneSeq = 0;

export function createWorkspacePaneId(): WorkspacePaneId {
  paneSeq += 1;
  const r = ((Math.random() * 0x100000) | 0).toString(36);
  return `wp-${paneSeq}-${r}`;
}

export function workspaceLeaf(workspaceId: WorkspaceId): WorkspaceLeafNode {
  return {
    type: 'leaf',
    id: createWorkspacePaneId(),
    workspaceId,
  };
}

export function workspaceLeaves(node: WorkspaceLayoutNode): readonly WorkspaceLeafNode[] {
  if (node.type === 'leaf') return [node];
  return [...workspaceLeaves(node.a), ...workspaceLeaves(node.b)];
}

export function clampWorkspaceRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

export function splitWorkspaceLeaf(
  root: WorkspaceLayoutNode,
  leafId: WorkspacePaneId,
  workspaceId: WorkspaceId,
  dir: WorkspaceSplitDir,
  side: 'before' | 'after' = 'after',
): WorkspaceLayoutNode {
  const walk = (node: WorkspaceLayoutNode): WorkspaceLayoutNode => {
    if (node.type === 'leaf') {
      if (node.id !== leafId) return node;
      const fresh = workspaceLeaf(workspaceId);
      return {
        type: 'split',
        id: createWorkspacePaneId(),
        dir,
        ratio: 0.5,
        a: side === 'before' ? fresh : node,
        b: side === 'before' ? node : fresh,
      };
    }
    return { ...node, a: walk(node.a), b: walk(node.b) };
  };
  return walk(root);
}

export function setWorkspaceLeaf(
  root: WorkspaceLayoutNode,
  leafId: WorkspacePaneId,
  workspaceId: WorkspaceId,
): WorkspaceLayoutNode {
  const walk = (node: WorkspaceLayoutNode): WorkspaceLayoutNode => {
    if (node.type === 'leaf') {
      return node.id === leafId ? { ...node, workspaceId } : node;
    }
    return { ...node, a: walk(node.a), b: walk(node.b) };
  };
  return walk(root);
}

export function setWorkspaceSplitRatio(
  root: WorkspaceLayoutNode,
  splitId: WorkspacePaneId,
  ratio: number,
): WorkspaceLayoutNode {
  const walk = (node: WorkspaceLayoutNode): WorkspaceLayoutNode => {
    if (node.type === 'leaf') return node;
    if (node.id === splitId) return { ...node, ratio: clampWorkspaceRatio(ratio) };
    return { ...node, a: walk(node.a), b: walk(node.b) };
  };
  return walk(root);
}

/**
 * Coerce persisted JSON back into a layout tree, dropping leaves whose workspace
 * no longer exists (collapsing a split to its surviving child). Returns null when
 * nothing valid remains, so the caller falls back to a fresh single-pane layout.
 */
export function sanitizeWorkspaceLayout(
  value: unknown,
  isValidWorkspace: (id: WorkspaceId) => boolean,
): WorkspaceLayoutNode | null {
  const walk = (node: unknown): WorkspaceLayoutNode | null => {
    if (!node || typeof node !== 'object') return null;
    const o = node as Record<string, unknown>;
    if (o.type === 'leaf') {
      if (typeof o.id !== 'string' || typeof o.workspaceId !== 'string') return null;
      if (!isValidWorkspace(o.workspaceId)) return null;
      return { type: 'leaf', id: o.id, workspaceId: o.workspaceId };
    }
    if (o.type === 'split') {
      if (typeof o.id !== 'string') return null;
      const dir: WorkspaceSplitDir = o.dir === 'col' ? 'col' : 'row';
      const ratio = clampWorkspaceRatio(typeof o.ratio === 'number' ? o.ratio : 0.5);
      const a = walk(o.a);
      const b = walk(o.b);
      if (a && b) return { type: 'split', id: o.id, dir, ratio, a, b };
      return a ?? b; // one side gone — collapse to the survivor
    }
    return null;
  };
  return walk(value);
}

export function removeWorkspaceLeaf(
  root: WorkspaceLayoutNode,
  leafId: WorkspacePaneId,
): WorkspaceLayoutNode {
  const walk = (node: WorkspaceLayoutNode): WorkspaceLayoutNode | null => {
    if (node.type === 'leaf') return node.id === leafId ? null : node;
    const a = walk(node.a);
    const b = walk(node.b);
    if (a && b) return { ...node, a, b };
    return a ?? b;
  };
  return walk(root) ?? root;
}

export function findSiblingLeaf(
  root: WorkspaceLayoutNode,
  leafId: WorkspacePaneId,
): WorkspaceLeafNode | null {
  if (root.type === 'leaf') return null;
  if (root.a.type === 'leaf' && root.a.id === leafId) {
    return workspaceLeaves(root.b)[0] ?? null;
  }
  if (root.b.type === 'leaf' && root.b.id === leafId) {
    return workspaceLeaves(root.a)[0] ?? null;
  }
  return findSiblingLeaf(root.a, leafId) ?? findSiblingLeaf(root.b, leafId);
}
