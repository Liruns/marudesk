import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import { cn } from '../../../lib/cn';
import { ContextMenu, type MenuItem } from '../../../components/ContextMenu';
import { useDevtoolsStore } from '../store';
import { NODE_TYPE, type CdpNode, type NodeId } from '../types';
import {
  commitOuterHtml,
  deleteNode,
  duplicateNode,
  fetchOuterHtml,
  toggleHideNode,
} from './dom-actions';

/**
 * The DOM tree. Flattens the store's node index + expanded set into a visible
 * row list each render (cheap for typical pages; the maps are immutable so
 * memoisation keys cleanly), then renders indented rows. Whitespace-only text
 * nodes are hidden to match DevTools.
 *
 * Editing: right-click opens a context menu (Edit as HTML / Duplicate / Hide /
 * Delete); with the tree focused, F2 / H / Delete drive the same actions on the
 * selected node. Edit-as-HTML swaps the node's row (and its subtree) for an
 * inline textarea seeded from `DOM.getOuterHTML`.
 */

type Row = { id: NodeId; depth: number; hasKids: boolean };

/** Edit-as-HTML inline editor: Ctrl/Cmd+Enter or blur commits, Esc cancels. */
function HtmlEditor({
  nodeId,
  initial,
  depth,
  onDone,
}: {
  nodeId: NodeId;
  initial: string;
  depth: number;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Set when Esc cancels, so the unmount-blur can't also commit.
  const cancelled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(0, 0);
  }, []);
  const commit = () => {
    if (cancelled.current) return;
    cancelled.current = true; // a commit is also final — block the blur re-entry
    onDone();
    if (draft !== initial) void commitOuterHtml(nodeId, draft);
  };
  return (
    <div className="py-1 pr-2" style={{ paddingLeft: depth * 12 + 8 }}>
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            cancelled.current = true;
            onDone();
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit();
          }
        }}
        spellCheck={false}
        aria-label={t('devtools.dom.editAsHtml')}
        rows={Math.min(12, Math.max(3, draft.split('\n').length + 1))}
        className="w-full bg-surface-page border border-accent rounded px-1.5 py-1 font-mono text-caption text-fg-primary focus:outline-none resize-y"
      />
      <div className="text-caption text-fg-tertiary pt-0.5">
        Ctrl+Enter commits, Esc cancels
      </div>
    </div>
  );
}

function isWhitespaceText(node: CdpNode): boolean {
  return node.nodeType === NODE_TYPE.TEXT && node.nodeValue.trim() === '';
}

function attrPairs(attributes: string[] | undefined): [string, string][] {
  const out: [string, string][] = [];
  if (!attributes) return out;
  for (let i = 0; i < attributes.length; i += 2) {
    out.push([attributes[i], attributes[i + 1] ?? '']);
  }
  return out;
}

/**
 * An attribute value that becomes an inline editor on double-click (single-click
 * is reserved for selecting the row), committing via `DOM.setAttributeValue`.
 * Pointer/key events are stopped so editing never selects or navigates the tree.
 */
function AttrValue({
  nodeId,
  name,
  value,
}: {
  nodeId: NodeId;
  name: string;
  value: string;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);

  if (editing) {
    const commit = () => {
      setEditing(false);
      if (draft !== value) void useDevtoolsStore.getState().setAttribute(nodeId, name, draft);
    };
    return (
      <input
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
        spellCheck={false}
        aria-label={`${t('devtools.styles.editBefore')}${name}`}
        className="bg-surface-page border border-accent rounded-sm px-0.5 font-mono text-caption text-success focus:outline-none w-24 align-baseline"
      />
    );
  }
  return (
    <span
      className="text-success cursor-text"
      title={t('devtools.dom.doubleClickEdit')}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setDraft(value);
        setEditing(true);
      }}
    >
      "{value}"
    </span>
  );
}

function NodeLabel({ node }: { node: CdpNode }) {
  if (node.nodeType === NODE_TYPE.ELEMENT) {
    const tag = node.localName || node.nodeName.toLowerCase();
    return (
      <span className="font-mono text-caption">
        <span className="text-fg-tertiary">&lt;</span>
        <span className="text-accent">{tag}</span>
        {attrPairs(node.attributes).map(([name, value]) => (
          <span key={name}>
            {' '}
            <span className="text-warning">{name}</span>
            <span className="text-fg-tertiary">=</span>
            <AttrValue nodeId={node.nodeId} name={name} value={value} />
          </span>
        ))}
        <span className="text-fg-tertiary">&gt;</span>
      </span>
    );
  }
  if (node.nodeType === NODE_TYPE.TEXT) {
    return (
      <span className="font-mono text-caption text-fg-secondary truncate">
        "{node.nodeValue.trim()}"
      </span>
    );
  }
  if (node.nodeType === NODE_TYPE.COMMENT) {
    return (
      <span className="font-mono text-caption text-fg-tertiary truncate">
        &lt;!-- {node.nodeValue.trim()} --&gt;
      </span>
    );
  }
  if (node.nodeType === NODE_TYPE.DOCTYPE) {
    return (
      <span className="font-mono text-caption text-fg-tertiary">
        &lt;!DOCTYPE {node.nodeName}&gt;
      </span>
    );
  }
  return (
    <span className="font-mono text-caption text-fg-tertiary">{node.nodeName}</span>
  );
}

export function DomTree() {
  const { t } = useI18n();
  const nodes = useDevtoolsStore((s) => s.nodes);
  const childIds = useDevtoolsStore((s) => s.childIds);
  const expanded = useDevtoolsStore((s) => s.expanded);
  const documentId = useDevtoolsStore((s) => s.documentId);
  const selectedId = useDevtoolsStore((s) => s.selectedId);
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: NodeId } | null>(null);
  const [htmlEdit, setHtmlEdit] = useState<{ nodeId: NodeId; initial: string } | null>(null);

  // The edited node can die under us (navigation / DOM.documentUpdated swap /
  // removal by the page) — drop the editor rather than commit into a dead id.
  // Render-phase reset (store-previous-prop pattern), not an effect.
  if (htmlEdit !== null && !nodes.has(htmlEdit.nodeId)) setHtmlEdit(null);
  const editingId = htmlEdit !== null && nodes.has(htmlEdit.nodeId) ? htmlEdit.nodeId : null;

  const startHtmlEdit = async (nodeId: NodeId) => {
    // Element nodes only (matches the menu gating): setOuterHTML rejects others.
    if (nodes.get(nodeId)?.nodeType !== NODE_TYPE.ELEMENT) return;
    const html = await fetchOuterHtml(nodeId);
    if (html === null) return;
    setHtmlEdit({ nodeId, initial: html });
  };

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (documentId === null) return out;
    const walk = (id: NodeId, depth: number) => {
      const node = nodes.get(id);
      if (!node || isWhitespaceText(node)) return;
      const kids = childIds.get(id);
      const hasKids = (node.childNodeCount ?? (kids ? kids.length : 0)) > 0;
      out.push({ id, depth, hasKids });
      if (id === editingId) return; // subtree is replaced by the HTML editor
      if (hasKids && expanded.has(id) && kids) {
        for (const k of kids) walk(k, depth + 1);
      }
    };
    for (const id of childIds.get(documentId) ?? []) walk(id, 0);
    return out;
  }, [nodes, childIds, expanded, documentId, editingId]);

  const menuNode = menu ? nodes.get(menu.nodeId) : undefined;
  const menuIsElement = menuNode?.nodeType === NODE_TYPE.ELEMENT;
  const menuItems: MenuItem[] = menu
    ? [
        {
          label: 'Edit as HTML',
          shortcut: 'F2',
          disabled: !menuIsElement,
          onSelect: () => void startHtmlEdit(menu.nodeId),
        },
        {
          label: 'Duplicate element',
          disabled: !menuIsElement,
          onSelect: () => void duplicateNode(menu.nodeId),
        },
        {
          label: 'Hide element',
          shortcut: 'H',
          disabled: !menuIsElement,
          onSelect: () => void toggleHideNode(menu.nodeId),
        },
        { type: 'separator' },
        {
          label: 'Delete node',
          shortcut: 'Del',
          danger: true,
          onSelect: () => void deleteNode(menu.nodeId),
        },
      ]
    : [];

  if (documentId === null) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        {t('devtools.dom.noDocument')}
      </div>
    );
  }

  return (
    <div
      tabIndex={0}
      className="h-full overflow-auto py-1 focus:outline-none"
      onMouseLeave={() => useDevtoolsStore.getState().hideHighlight()}
      onKeyDown={(e) => {
        // Editing inputs (attribute editor / HTML editor) stop propagation, so
        // these only fire while the tree itself holds focus.
        const sel = useDevtoolsStore.getState().selectedId;
        if (sel === null || htmlEdit !== null) return;
        if (e.key === 'Delete') {
          e.preventDefault();
          void deleteNode(sel);
        } else if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          void toggleHideNode(sel);
        } else if (e.key === 'F2') {
          e.preventDefault();
          void startHtmlEdit(sel);
        }
      }}
    >
      {rows.map((row) => {
        const node = nodes.get(row.id);
        if (!node) return null;
        if (row.id === editingId && htmlEdit) {
          return (
            <HtmlEditor
              key={`edit-${row.id}`}
              nodeId={row.id}
              initial={htmlEdit.initial}
              depth={row.depth}
              onDone={() => setHtmlEdit(null)}
            />
          );
        }
        const selected = row.id === selectedId;
        return (
          <div
            key={row.id}
            role="treeitem"
            aria-selected={selected}
            onMouseEnter={() => useDevtoolsStore.getState().highlightNode(row.id)}
            onClick={() => void useDevtoolsStore.getState().selectNode(row.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              void useDevtoolsStore.getState().selectNode(row.id);
              setMenu({ x: e.clientX, y: e.clientY, nodeId: row.id });
            }}
            className={cn(
              'flex items-center h-5 pr-2 cursor-default whitespace-nowrap',
              selected ? 'bg-accent-subtle/50' : 'hover:bg-surface-2',
            )}
            style={{ paddingLeft: row.depth * 12 + 4 }}
          >
            {row.hasKids ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  useDevtoolsStore.getState().toggleExpand(row.id);
                }}
                aria-label={expanded.has(row.id) ? t('search.collapse') : t('search.expand')}
                className="size-4 shrink-0 flex items-center justify-center text-fg-tertiary hover:text-fg-primary"
              >
                <ChevronRight
                  size={12}
                  className={cn('transition-transform', expanded.has(row.id) && 'rotate-90')}
                />
              </button>
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <NodeLabel node={node} />
            {row.hasKids && !expanded.has(row.id) ? (
              <span className="text-fg-tertiary font-mono text-caption">…</span>
            ) : null}
          </div>
        );
      })}
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  );
}
