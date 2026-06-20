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

/**
 * Typed runtime snapshot (SECOND-PASS "Typed runtime snapshot"). A stable,
 * serializable projection of ALL live agent work — every thread plus its
 * background agents, with their per-thread token usage — derived by a pure
 * function ({@link import('../electron/agent/orchestration-state').deriveRuntimeSnapshot}).
 *
 * Distinct from the per-thread {@link AgentRunTreeNode} tree the chat UI already
 * gets via coalesced IPC: this is one flat, whole-runtime view for a future
 * HUD/status card, a test harness, or a bug-report dump. The shape is intended to
 * stay stable (additive only), so a dump from one build is readable by another.
 */
export const RUNTIME_SNAPSHOT_VERSION = 1;

export type RuntimeThreadSnapshot = {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  /** True while this thread has a turn in flight. */
  readonly busy: boolean;
  /** True for the workspace's (or global) active thread. */
  readonly active: boolean;
  readonly provider: string | null;
  readonly model: string | null;
  readonly startedAt: number | null;
  /** Cumulative billing-style token totals + the last context-window size. */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly contextTokens: number };
  /** Count of background agents this thread owns (also enumerated below). */
  readonly backgroundCount: number;
  readonly background: readonly RuntimeBackgroundSnapshot[];
};

export type RuntimeBackgroundSnapshot = {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly provider: string;
  readonly model: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  /** True while the agent is still running. */
  readonly running: boolean;
};

export type RuntimeSnapshot = {
  readonly version: typeof RUNTIME_SNAPSHOT_VERSION;
  /** When this snapshot was derived (epoch ms). */
  readonly capturedAt: number;
  /** Roll-ups across every thread, for an at-a-glance HUD line. */
  readonly totals: {
    readonly threads: number;
    readonly busyThreads: number;
    readonly backgroundAgents: number;
    readonly runningBackgroundAgents: number;
  };
  readonly threads: readonly RuntimeThreadSnapshot[];
};
