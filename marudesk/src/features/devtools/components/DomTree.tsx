import { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import { NODE_TYPE, type CdpNode, type NodeId } from '../types';

/**
 * The DOM tree. Flattens the store's node index + expanded set into a visible
 * row list each render (cheap for typical pages; the maps are immutable so
 * memoisation keys cleanly), then renders indented rows. Whitespace-only text
 * nodes are hidden to match DevTools.
 */

type Row = { id: NodeId; depth: number; hasKids: boolean };

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
            <span className="text-success">"{value}"</span>
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
  const nodes = useDevtoolsStore((s) => s.nodes);
  const childIds = useDevtoolsStore((s) => s.childIds);
  const expanded = useDevtoolsStore((s) => s.expanded);
  const documentId = useDevtoolsStore((s) => s.documentId);
  const selectedId = useDevtoolsStore((s) => s.selectedId);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (documentId === null) return out;
    const walk = (id: NodeId, depth: number) => {
      const node = nodes.get(id);
      if (!node || isWhitespaceText(node)) return;
      const kids = childIds.get(id);
      const hasKids = (node.childNodeCount ?? (kids ? kids.length : 0)) > 0;
      out.push({ id, depth, hasKids });
      if (hasKids && expanded.has(id) && kids) {
        for (const k of kids) walk(k, depth + 1);
      }
    };
    for (const id of childIds.get(documentId) ?? []) walk(id, 0);
    return out;
  }, [nodes, childIds, expanded, documentId]);

  if (documentId === null) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        No document
      </div>
    );
  }

  return (
    <div
      className="h-full overflow-auto py-1"
      onMouseLeave={() => useDevtoolsStore.getState().hideHighlight()}
    >
      {rows.map((row) => {
        const node = nodes.get(row.id);
        if (!node) return null;
        const selected = row.id === selectedId;
        return (
          <div
            key={row.id}
            role="treeitem"
            aria-selected={selected}
            onMouseEnter={() => useDevtoolsStore.getState().highlightNode(row.id)}
            onClick={() => void useDevtoolsStore.getState().selectNode(row.id)}
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
                aria-label={expanded.has(row.id) ? 'Collapse' : 'Expand'}
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
    </div>
  );
}
