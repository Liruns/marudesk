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
  return `workspace-pane-${paneSeq}`;
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
