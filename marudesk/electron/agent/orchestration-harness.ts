import assert from 'node:assert/strict';
import { approveTool } from './loop-turn-actions.ts';
import {
  S,
  MAIN_THREAD,
  __resetThreadsForTests,
  closeThread,
  containerForWorkspace,
  newThread,
  refreshOrchestrationProjection,
  subscribeAgentEvents,
  switchThread,
} from './loop-state.ts';
import {
  cancelBackgroundForConversation,
  cancelBackgroundTool,
  setBackgroundRunnerForTests,
  startBackgroundAgentTool,
  whenBackgroundSettled,
} from './background.ts';
import { listChildToolDefs } from './subagent.ts';
import { registerMcpServer, unregisterMcpServer } from './mcp.ts';
import type { ToolContext } from './tools/types.ts';
import type { SubagentRunRequest } from './subagent-types.ts';
import { emptyAgentChatState } from '../../shared/agent';
import { dispatchAgentCommand, type AgentApi } from '../server/dispatch.ts';

let passed = 0;

function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

function ackId(text: string): string {
  return text.match(/agent (bg-[\w-]+)/)?.[1] ?? '';
}

function ctx(): ToolContext {
  return {
    ws: null,
    signal: new AbortController().signal,
    provider: 'ollama',
    model: 'qwen2.5-coder',
    thread: S,
  };
}

function setConversation(title: string, session: string): void {
  S.conversationId = session;
  S.conversationTitle = title;
  S.conversationProvider = 'ollama';
  S.conversationModel = 'qwen2.5-coder';
  S.conversationStartedAt = Date.now();
  S.state.activeSessionId = session;
}

function flushEvents(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

__resetThreadsForTests();

setConversation('Root lane', 'session-root');
S.state.status = 'working';
const sideThread = newThread();
switchThread(sideThread);
setConversation('Side lane', 'session-side');
S.state.status = 'waiting_for_user';

setBackgroundRunnerForTests((request: SubagentRunRequest) => {
  if (request.label === 'done child') {
    return Promise.resolve({ summary: 'done child', text: 'done child report' });
  }
  return new Promise(() => {});
});

switchThread(MAIN_THREAD);
const running = startBackgroundAgentTool({ task: 'long root work', label: 'running child' }, ctx());
const runningId = ackId(running.text);
check('running background spawn returns an id', runningId.startsWith('bg-'));

switchThread(sideThread);
const done = startBackgroundAgentTool({ task: 'finished side work', label: 'done child' }, ctx());
const doneId = ackId(done.text);
await whenBackgroundSettled(doneId);
const cancelled = startBackgroundAgentTool({ task: 'cancel side work', label: 'cancelled child' }, ctx());
const cancelledId = ackId(cancelled.text);
cancelBackgroundTool({ id: cancelledId }, ctx());

refreshOrchestrationProjection();
const tree = S.state.orchestration;
check('orchestration projects both foreground threads', tree.length === 2);
check('active side thread is first in the tree', tree[0]?.id === `thread:${sideThread}`);
check('active side thread is marked active and busy', tree[0]?.active === true && tree[0]?.busy === true);
check('main thread remains visible as busy', tree.some((node) => node.id === 'thread:main' && node.busy === true));
check(
  'background child nodes include running/done/cancelled statuses',
  tree.flatMap((node) => node.children).some((node) => node.status === 'running') &&
    tree.flatMap((node) => node.children).some((node) => node.status === 'done') &&
    tree.flatMap((node) => node.children).some((node) => node.status === 'cancelled'),
);
check(
  'background child nodes retain provider/model labels',
  tree.flatMap((node) => node.children).every((node) => node.provider === 'ollama' && node.model === 'qwen2.5-coder'),
);

let mainApproved: boolean | null = null;
let sideApproved: boolean | null = null;
switchThread(MAIN_THREAD);
S.state.turnId = 'turn-main';
S.state.pendingApproval = {
  turnId: 'turn-main',
  callId: 'call-main',
  name: 'run_command',
  detail: 'rtk npm run test',
};
S.approvalResolver = (decision) => {
  mainApproved = decision.approved;
};
switchThread(sideThread);
S.state.turnId = 'turn-side';
S.state.pendingApproval = {
  turnId: 'turn-side',
  callId: 'call-side',
  name: 'eval_js',
  detail: 'document.body.innerText',
};
S.approvalResolver = (decision) => {
  sideApproved = decision.approved;
};

refreshOrchestrationProjection();
const queue = S.state.approvalQueue;
check('approvalQueue projects parked approvals from both threads', queue.length === 2);
check('approvalQueue puts the active thread first', queue[0]?.threadId === sideThread);
check('approvalQueue carries source thread metadata', queue.every((item) => item.source === 'thread' && item.threadTitle.endsWith('lane')));
check('pendingApproval remains compatible with the active thread item', S.state.pendingApproval?.callId === queue[0]?.callId);
check('approveTool routes to a non-active thread by turnId/callId', approveTool('turn-main', 'call-main', true) === true && mainApproved === true);
check('approveTool can deny the active thread item', approveTool('turn-side', 'call-side', false) === true && sideApproved === false);
check('approveTool rejects stale or unknown approval ids', approveTool('turn-side', 'missing', true) === false && approveTool('missing', 'call-side', true) === false);

const alphaThread = newThread('alpha');
const betaThread = newThread('beta');
const alphaContainer = containerForWorkspace('alpha');
const betaContainer = containerForWorkspace('beta');
alphaContainer.conversationTitle = 'Alpha lane';
alphaContainer.state.turnId = 'turn-alpha';
alphaContainer.state.pendingApproval = {
  turnId: 'turn-alpha',
  callId: 'call-alpha',
  name: 'run_command',
  detail: 'alpha command',
};
betaContainer.conversationTitle = 'Beta lane';
betaContainer.state.turnId = 'turn-beta';
betaContainer.state.pendingApproval = {
  turnId: 'turn-beta',
  callId: 'call-beta',
  name: 'eval_js',
  detail: 'beta script',
};
refreshOrchestrationProjection();
check('workspace approvalQueue is scoped to the owning workspace', alphaContainer.state.approvalQueue.every((item) => item.threadId === alphaThread));
check('workspace orchestration tree hides sibling workspace threads', !alphaContainer.state.orchestration.some((node) => node.id === `thread:${betaThread}`));
check('global orchestration tree hides workspace threads', !S.state.orchestration.some((node) => node.id === `thread:${alphaThread}` || node.id === `thread:${betaThread}`));

let remoteApproved = false;
let remoteApprovalCalls = 0;
const remoteState = emptyAgentChatState();
remoteState.approvalQueue = [
  {
    turnId: 'turn-remote',
    callId: 'call-remote',
    name: 'eval_js',
    detail: 'document.body.innerText',
    threadId: 'side',
    threadTitle: 'Side lane',
    activeThread: false,
    source: 'thread',
  },
];
const remoteApi = {
  startTurn: async () => ({ ok: true, turnId: 'turn-remote' }),
  abortTurn: () => false,
  respond: () => false,
  approveTool: (_turnId, _callId, approved) => {
    remoteApprovalCalls += 1;
    remoteApproved = approved;
    return true;
  },
  snapshot: () => remoteState,
  reset: () => false,
  editPlanStep: () => false,
  setApprovalMode: () => false,
  setReasoningEffort: () => false,
} satisfies AgentApi;
const remoteGuard = {
  serverExposed: () => true,
  isGated: (name: string) => name === 'eval_js',
};
const remoteApprove = await dispatchAgentCommand(
  remoteApi,
  'approve',
  { turnId: 'turn-remote', callId: 'call-remote', approved: true },
  remoteGuard,
);
check('remote approve of a queued non-active gated tool is rejected', remoteApprove.ok === false && remoteApprovalCalls === 0);
const remoteDeny = await dispatchAgentCommand(
  remoteApi,
  'approve',
  { turnId: 'turn-remote', callId: 'call-remote', approved: false },
  remoteGuard,
);
check('remote deny of a queued non-active gated tool still reaches the loop', remoteDeny.ok === true && remoteApprovalCalls === 1 && remoteApproved === false);

await flushEvents();
let closeEvents = 0;
let closeEventIds: string[] = [];
const unsubscribe = subscribeAgentEvents((state) => {
  closeEvents += 1;
  closeEventIds = state.orchestration.map((node) => node.id);
});
const staleThread = newThread();
const staleNodeId = `thread:${staleThread}`;
refreshOrchestrationProjection();
check('inactive close regression setup includes the extra thread node', S.state.orchestration.some((node) => node.id === staleNodeId));
check('closing an inactive thread succeeds', closeThread(staleThread) === true);
await flushEvents();
check('inactive close removes the thread from the active orchestration snapshot', !S.state.orchestration.some((node) => node.id === staleNodeId));
check('inactive close pushes an active chat snapshot event', closeEvents > 0 && !closeEventIds.includes(staleNodeId));
unsubscribe();

registerMcpServer({
  name: 'orchestration-external-test',
  tools: [
    {
      name: 'orch_external__read',
      description: 'external read',
      group: 'mcp',
      gated: false,
      write: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      exec: async () => ({ summary: 'ok', text: 'ok' }),
    },
  ],
});
const childTools = listChildToolDefs();
const childNames = new Set(childTools.map((tool) => tool.name));
check('child toolset still excludes nested/background/update_plan tools', !['spawn_subagent', 'spawn_background_agent', 'collect_background_agent', 'cancel_background_agent', 'update_plan'].some((name) => childNames.has(name)));
check('child toolset still exposes no write tools', childTools.every((tool) => tool.write !== true));
check('child toolset still excludes external MCP tools', !childNames.has('orch_external__read'));
check('child toolset still exposes no gated tools except read-only web research', childTools.every((tool) => tool.gated !== true || ['web_search', 'fetch_url'].includes(tool.name)));
unregisterMcpServer('orchestration-external-test');

cancelBackgroundForConversation('session-root');
cancelBackgroundForConversation('session-side');
setBackgroundRunnerForTests(null);
__resetThreadsForTests();

console.log(`\norchestration harness: ${passed} assertions passed`);
