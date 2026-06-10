/**
 * Renderer-visible orchestration projections for live agent work. These are
 * display contracts only; execution and approval decisions still live in main.
 */

export type ApprovalQueueSource = 'thread';

export type ApprovalQueueItem = {
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
  readonly detail: string;
  readonly diffs?: readonly { readonly path: string; readonly before: string; readonly after: string }[];
  readonly threadId: string;
  readonly threadTitle: string;
  readonly activeThread: boolean;
  readonly source: ApprovalQueueSource;
};

export type AgentRunTreeNodeKind = 'thread' | 'background-agent';

export type AgentRunTreeNode = {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: AgentRunTreeNodeKind;
  readonly label: string;
  readonly status: string;
  readonly detail?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly active?: boolean;
  readonly busy?: boolean;
  readonly startedAt?: number;
  readonly finishedAt?: number | null;
  readonly children: readonly AgentRunTreeNode[];
};
