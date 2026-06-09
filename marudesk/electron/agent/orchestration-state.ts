import type { AgentRunTreeNode, ApprovalQueueItem } from '../../shared/agent-orchestration';
import type { BackgroundTask } from '../../shared/agent';
import type { ThreadContainer } from './loop-state';

export type OrchestrationThreadEntry = {
  readonly id: string;
  readonly container: ThreadContainer;
  readonly active: boolean;
};

export function refreshOrchestrationState(entries: readonly OrchestrationThreadEntry[]): void {
  for (const { container } of entries) {
    const scopedEntries = entries.filter((entry) => sameWorkspaceScope(entry.container, container));
    container.state.approvalQueue = buildApprovalQueue(scopedEntries);
    container.state.orchestration = buildOrchestrationTree(scopedEntries);
  }
}

export function buildApprovalQueue(
  entries: readonly OrchestrationThreadEntry[],
): ApprovalQueueItem[] {
  return sortedEntries(entries).flatMap(({ id, container, active }) => {
    const pending = container.state.pendingApproval;
    if (!pending) return [];
    return [
      {
        turnId: pending.turnId,
        callId: pending.callId,
        name: pending.name,
        detail: pending.detail,
        ...(pending.diffs ? { diffs: pending.diffs } : {}),
        threadId: id,
        threadTitle: threadTitle(container),
        activeThread: active,
        source: 'thread' as const,
      },
    ];
  });
}

export function buildOrchestrationTree(
  entries: readonly OrchestrationThreadEntry[],
): AgentRunTreeNode[] {
  return sortedEntries(entries).map(({ id, container, active }) => {
    const nodeId = threadNodeId(id);
    return {
      id: nodeId,
      parentId: null,
      kind: 'thread',
      label: threadTitle(container),
      status: container.state.status,
      provider: container.conversationProvider || undefined,
      model: container.conversationModel || undefined,
      active,
      busy: isContainerBusy(container),
      startedAt: container.conversationStartedAt || undefined,
      finishedAt: null,
      children: container.state.background.map((task) => backgroundNode(task, nodeId)),
    };
  });
}

function backgroundNode(task: BackgroundTask, parentId: string): AgentRunTreeNode {
  return {
    id: `background:${task.id}`,
    parentId,
    kind: 'background-agent',
    label: task.label,
    status: task.status,
    detail: task.task,
    provider: task.provider,
    model: task.model,
    active: task.status === 'running',
    busy: task.status === 'running',
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    children: [],
  };
}

function sortedEntries(
  entries: readonly OrchestrationThreadEntry[],
): OrchestrationThreadEntry[] {
  return [...entries].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

function threadNodeId(threadId: string): string {
  return `thread:${threadId}`;
}

function threadTitle(container: ThreadContainer): string {
  return container.conversationTitle || 'New chat';
}

function isContainerBusy(container: ThreadContainer): boolean {
  return (
    container.starting ||
    container.state.status === 'thinking' ||
    container.state.status === 'working' ||
    container.state.status === 'waiting_for_user'
  );
}

function sameWorkspaceScope(a: ThreadContainer, b: ThreadContainer): boolean {
  return (a.workspaceId ?? null) === (b.workspaceId ?? null);
}
