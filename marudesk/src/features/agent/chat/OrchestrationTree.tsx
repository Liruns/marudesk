import { CheckCircle2, CircleDot, GitBranch, Loader2, XCircle } from 'lucide-react';
import type { AgentRunTreeNode } from '../../../../shared/agent-orchestration';
import { Badge } from '../../../components/ui';
import { cn } from '../../../lib/cn';

export function OrchestrationTree({
  nodes,
}: {
  readonly nodes: readonly AgentRunTreeNode[];
}) {
  if (nodes.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded border border-subtle bg-surface-2 p-2.5">
      <div className="flex items-center gap-2 text-caption uppercase tracking-wider text-fg-tertiary">
        <GitBranch size={13} className="shrink-0" />
        <span>Agent tree</span>
        <span className="ml-auto tabular-nums">{nodes.length}</span>
      </div>
      <ol className="flex flex-col gap-1">
        {nodes.map((node) => (
          <TreeNode key={node.id} node={node} depth={0} />
        ))}
      </ol>
    </div>
  );
}

// Module-level so the per-status icon is a stable component reference, never
// re-created during render.
const STATUS_ICON: Record<string, typeof Loader2> = {
  done: CheckCircle2,
  completed: CheckCircle2,
  error: XCircle,
  failed: XCircle,
  cancelled: CircleDot,
  idle: CircleDot,
};

function TreeNode({
  node,
  depth,
}: {
  readonly node: AgentRunTreeNode;
  readonly depth: number;
}) {
  const Icon = STATUS_ICON[node.status] ?? Loader2;
  return (
    <li>
      <div
        className={cn(
          'flex items-center gap-2 rounded px-1 py-0.5 text-body-sm',
          node.active ? 'bg-accent-subtle/20' : 'hover:bg-surface-3',
        )}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        <Icon
          size={13}
          className={cn(
            'shrink-0',
            node.busy && 'animate-spin text-accent',
            node.status === 'done' && 'text-success',
            node.status === 'error' && 'text-error',
            node.status === 'cancelled' && 'text-fg-tertiary',
            !node.busy && node.status !== 'done' && node.status !== 'error' && 'text-fg-tertiary',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-fg-primary" title={node.label}>
          {node.label}
        </span>
        {node.provider && node.model ? (
          <Badge variant="neutral">
            {node.provider}/{node.model}
          </Badge>
        ) : null}
        <span className="shrink-0 text-caption text-fg-tertiary">{node.status}</span>
      </div>
      {node.children.length > 0 ? (
        <ol className="mt-1 flex flex-col gap-1">
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

