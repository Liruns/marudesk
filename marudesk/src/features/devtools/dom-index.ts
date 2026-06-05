import type { CdpNode, NodeId } from './types';

/**
 * Pure DOM-tree indexing helpers for the Elements panel, split out of the store.
 * They operate on mutable containers the caller owns (the store clones before
 * indexing), keeping the tree flattened into id→node and id→childIds maps plus
 * the attribute array fiddling CDP uses (`[name, value, name, value, …]`).
 */

/** Flatten a CDP node subtree into the `nodes` / `childIds` maps in place. */
export function indexNode(
  node: CdpNode,
  nodes: Map<NodeId, CdpNode>,
  childIds: Map<NodeId, NodeId[]>,
): void {
  const { children, ...flat } = node;
  nodes.set(node.nodeId, flat);
  if (children) {
    childIds.set(
      node.nodeId,
      children.map((c) => c.nodeId),
    );
    for (const c of children) indexNode(c, nodes, childIds);
  } else if (node.childNodeCount === 0) {
    childIds.set(node.nodeId, []);
  }
}

/** Set (or append) an attribute in CDP's flat `[name, value, …]` array. */
export function setAttr(attrs: string[] | undefined, name: string, value: string): string[] {
  const next = attrs ? [...attrs] : [];
  for (let i = 0; i < next.length; i += 2) {
    if (next[i] === name) {
      next[i + 1] = value;
      return next;
    }
  }
  next.push(name, value);
  return next;
}

/** Remove an attribute from CDP's flat `[name, value, …]` array. */
export function removeAttr(attrs: string[] | undefined, name: string): string[] {
  const next: string[] = [];
  if (!attrs) return next;
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] !== name) next.push(attrs[i], attrs[i + 1]);
  }
  return next;
}
