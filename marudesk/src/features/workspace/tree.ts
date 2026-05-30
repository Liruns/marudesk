import type { FileEntry } from '../../../shared/workspace';

export type TreeNode = {
  name: string;
  /** POSIX path relative to the workspace root. */
  path: string;
  kind: 'dir' | 'file';
  /** Byte size for files; undefined for directories. */
  size?: number;
  children?: TreeNode[];
};

/** A tree node flattened for list rendering, carrying its indentation depth. */
export type FlatNode = TreeNode & { depth: number };

/**
 * Build a nested tree from the workspace's flat file list. Intermediate
 * directories are derived from the path segments — the backend returns files
 * only, so empty directories don't appear, which is acceptable for a v1
 * explorer.
 *
 * Sort order matches VSCode: directories before files, each group alphabetical
 * and case-insensitive.
 */
export function buildFileTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'dir', children: [] };

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      prefix = prefix ? `${prefix}/${part}` : part;
      const children = node.children;
      // A file node has no children — only possible via a pathological
      // file/dir name collision that can't occur on a real filesystem. Skip.
      if (!children) break;
      const isLeaf = i === parts.length - 1;
      let child = children.find((c) => c.name === part);
      if (!child) {
        child = isLeaf
          ? { name: part, path: prefix, kind: 'file', size: file.size }
          : { name: part, path: prefix, kind: 'dir', children: [] };
        children.push(child);
      }
      node = child;
    }
  }

  sortTree(root.children ?? []);
  return root.children ?? [];
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  for (const node of nodes) {
    if (node.children) sortTree(node.children);
  }
}

/**
 * Flatten the tree into the visible row list given the set of expanded
 * directory paths. A directory's children are emitted only when its path is in
 * `expanded`; everything starts collapsed.
 */
export function flattenTree(
  nodes: TreeNode[],
  expanded: Set<string>,
  depth = 0,
): FlatNode[] {
  const out: FlatNode[] = [];
  for (const node of nodes) {
    out.push({ ...node, depth });
    if (node.kind === 'dir' && node.children && expanded.has(node.path)) {
      out.push(...flattenTree(node.children, expanded, depth + 1));
    }
  }
  return out;
}
