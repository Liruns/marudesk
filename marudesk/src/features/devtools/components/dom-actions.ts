import { toast } from '../../../lib/toast';
import { toMessage } from '../../../lib/toMessage';
import { cdpSend, cdpTry } from '../cdp';
import { useDevtoolsStore } from '../store';
import { NODE_TYPE, type NodeId } from '../types';
import { getAttr, toggleVisibilityHidden } from './elements-utils';

/**
 * DOM-editing actions for the Elements tree (context menu / keyboard): delete,
 * hide, duplicate, and edit-as-HTML. They live beside the tree component rather
 * than in the store slice because they hold no state of their own — each is a
 * CDP round-trip whose result flows back through the existing live-update
 * events (`DOM.childNodeRemoved`/`-Inserted`, `DOM.attributeModified`), so the
 * tree updates without any extra bookkeeping here.
 */

/** Delete the node (Delete key). Selection moves to the parent if it pointed
 *  at the removed node. */
export async function deleteNode(nodeId: NodeId): Promise<void> {
  const s = useDevtoolsStore.getState();
  const tabId = s.tabId;
  if (!tabId) return;
  const parentId = s.nodes.get(nodeId)?.parentId;
  try {
    await cdpSend(tabId, 'DOM.removeNode', { nodeId });
  } catch (err) {
    toast({ title: 'Delete rejected', description: toMessage(err), variant: 'error' });
    return;
  }
  const cur = useDevtoolsStore.getState();
  if (
    cur.tabId === tabId &&
    cur.selectedId === nodeId &&
    parentId !== undefined &&
    cur.nodes.has(parentId)
  ) {
    void cur.selectNode(parentId);
  }
}

/**
 * Toggle the element's visibility (H key) by merging `visibility: hidden` into
 * its inline `style` attribute via `DOM.setAttributeValue`. Chrome instead
 * injects a stylesheet class; the inline attribute is chosen here because the
 * resulting `DOM.attributeModified` event round-trips through the existing tree
 * state (no injected-stylesheet bookkeeping) and toggling is idempotent per
 * node. Trade-off: it edits the page's own style attribute (visible in the
 * tree), and an author `visibility` value is not restored on un-hide.
 */
export async function toggleHideNode(nodeId: NodeId): Promise<void> {
  const s = useDevtoolsStore.getState();
  const tabId = s.tabId;
  const node = s.nodes.get(nodeId);
  if (!tabId || !node || node.nodeType !== NODE_TYPE.ELEMENT) return;
  const next = toggleVisibilityHidden(getAttr(node.attributes, 'style'));
  try {
    if (next === '') {
      await cdpSend(tabId, 'DOM.removeAttribute', { nodeId, name: 'style' });
    } else {
      await cdpSend(tabId, 'DOM.setAttributeValue', { nodeId, name: 'style', value: next });
    }
  } catch (err) {
    toast({ title: 'Hide rejected', description: toMessage(err), variant: 'error' });
  }
}

/** Duplicate the element in place (`DOM.copyTo` into the same parent, inserted
 *  right after the original). The copy appears via `DOM.childNodeInserted`. */
export async function duplicateNode(nodeId: NodeId): Promise<void> {
  const s = useDevtoolsStore.getState();
  const tabId = s.tabId;
  const node = s.nodes.get(nodeId);
  const parentId = node?.parentId;
  if (!tabId || !node || node.nodeType !== NODE_TYPE.ELEMENT || parentId === undefined) return;
  const siblings = s.childIds.get(parentId) ?? [];
  const at = siblings.indexOf(nodeId);
  // Insert before the next sibling = insert after the node; omitted (append)
  // when the node is the last child or the sibling list isn't indexed yet.
  const insertBeforeNodeId = at >= 0 ? siblings[at + 1] : undefined;
  try {
    await cdpSend(tabId, 'DOM.copyTo', {
      nodeId,
      targetNodeId: parentId,
      ...(insertBeforeNodeId !== undefined ? { insertBeforeNodeId } : {}),
    });
  } catch (err) {
    toast({ title: 'Duplicate rejected', description: toMessage(err), variant: 'error' });
  }
}

/** The node's current outer HTML, for seeding the edit-as-HTML editor. */
export async function fetchOuterHtml(nodeId: NodeId): Promise<string | null> {
  const tabId = useDevtoolsStore.getState().tabId;
  if (!tabId) return null;
  const res = await cdpTry<{ outerHTML: string }>(tabId, 'DOM.getOuterHTML', { nodeId });
  return res?.outerHTML ?? null;
}

/**
 * Commit an edit-as-HTML draft (`DOM.setOuterHTML`). The call REPLACES the
 * node: its nodeId dies, and the replacement subtree arrives through the
 * regular `DOM.childNodeRemoved`/`-Inserted` events (or `DOM.documentUpdated`
 * for large swaps, which triggers a full re-fetch). Selection is re-anchored to
 * the still-valid parent — re-finding the replacement among new siblings is not
 * reliably possible from the old id.
 */
export async function commitOuterHtml(nodeId: NodeId, html: string): Promise<void> {
  const s = useDevtoolsStore.getState();
  const tabId = s.tabId;
  if (!tabId) return;
  const parentId = s.nodes.get(nodeId)?.parentId;
  try {
    await cdpSend(tabId, 'DOM.setOuterHTML', { nodeId, outerHTML: html });
  } catch (err) {
    toast({ title: 'HTML edit rejected', description: toMessage(err), variant: 'error' });
    return;
  }
  const cur = useDevtoolsStore.getState();
  if (
    cur.tabId === tabId &&
    cur.selectedId === nodeId &&
    parentId !== undefined &&
    cur.nodes.has(parentId)
  ) {
    void cur.selectNode(parentId);
  }
}
