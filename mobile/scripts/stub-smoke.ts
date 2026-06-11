/**
 * Headless smoke test for StubTransport — proves the exact data path the Chat UI
 * subscribes to works end-to-end with no relay, PC, or DOM. Run:
 *   node --experimental-strip-types scripts/stub-smoke.ts
 *
 * It drives the same command sequence the screens issue (connect → send →
 * approve → respond) and asserts the fabricated AgentChatState passes through the
 * expected lifecycle, surfacing the streamed reply, tool card, approval, and
 * ask_user question that the UI renders.
 */
import { StubTransport } from '../src/transport/StubTransport.ts';
import type { AgentChatState } from '../src/types.ts';
import type { TransportStatusInfo } from '../src/transport/types.ts';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${msg}`);
  }
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(get: () => AgentChatState, pred: (s: AgentChatState) => boolean, label: string, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred(get())) return;
    await wait(40);
  }
  failures += 1;
  console.error(`FAIL  timed out waiting for: ${label}`);
}

function hasToolInLastAssistant(s: AgentChatState, name: string): boolean {
  const last = [...s.messages].reverse().find((m) => m.role === 'assistant');
  return Boolean(last?.parts.some((p) => p.type === 'tool' && p.call.name === name));
}
function assistantText(s: AgentChatState): string {
  const last = [...s.messages].reverse().find((m) => m.role === 'assistant');
  return (last?.parts ?? []).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
}

async function main(): Promise<void> {
  const t = new StubTransport();
  let state: AgentChatState | null = null;
  let status: TransportStatusInfo | null = null;
  t.onState((s) => (state = s));
  t.onStatus((s) => (status = s));

  console.log('connect →');
  await t.connect('http://127.0.0.1:8788', 'fake-token');
  await waitFor(() => state!, () => status?.status === 'connected' && status?.hostOnline === true, 'status connected + hostOnline');
  assert(status!.status === 'connected', 'transport reports connected');

  console.log('send →');
  await t.send('send', { provider: 'anthropic', model: 'claude-sonnet-4-6', prompt: 'Why is the cart crashing?', captures: [] });
  assert(state!.messages.some((m) => m.role === 'user'), 'user message recorded');
  await waitFor(() => state!, (s) => s.status === 'thinking', 'status thinking');
  await waitFor(() => state!, (s) => assistantText(s).length > 0, 'assistant text streams in');
  await waitFor(() => state!, (s) => s.status === 'working' && hasToolInLastAssistant(s, 'read_console'), 'tool card appears (read_console)');
  await waitFor(() => state!, (s) => s.pendingApproval !== null, 'parks on a pending approval');
  assert(state!.pendingApproval?.name === 'eval_js', 'approval is for the gated eval_js tool');
  assert(state!.status === 'waiting_for_user', 'status waiting_for_user during approval');

  console.log('approve →');
  await t.send('approve', { turnId: state!.pendingApproval!.turnId, callId: state!.pendingApproval!.callId, approved: true });
  await waitFor(() => state!, (s) => s.pendingApproval === null, 'approval cleared after approve');
  await waitFor(() => state!, (s) => s.pendingQuestions !== null, 'agent asks an ask_user question');
  assert((state!.pendingQuestions?.questions.length ?? 0) > 0, 'question set is non-empty');

  console.log('respond →');
  const q = state!.pendingQuestions!.questions[0]!;
  await t.send('respond', { turnId: state!.pendingQuestions!.turnId, callId: state!.pendingQuestions!.callId, answers: { [q.id]: q.options?.[0] ?? 'Proceed' } });
  await waitFor(() => state!, (s) => s.status === 'completed', 'turn completes after answer');
  assert(state!.pendingQuestions === null, 'questions cleared after respond');
  assert(state!.usage.outputTokens > 0, 'usage is populated on completion');

  console.log('reset →');
  await t.send('reset', {});
  assert(state!.messages.length === 0 && state!.status === 'idle', 'reset clears conversation to idle');

  console.log('catalog →');
  const ws = await t.catalog.workspaces();
  assert(ws.workspaces.length === 2 && ws.activeWorkspaceId === 'stub-ws-app', 'workspaces listed with the PC-active one');
  const models = await t.catalog.models();
  assert(models.providers.some((p) => p.connected && p.models.length > 0), 'model catalog has a connected provider');
  const sessions = await t.catalog.sessions('stub-ws-app');
  assert(sessions.length === 2, 'sessions listed for the workspace scope');
  const resumed = await t.catalog.resumeSession(sessions[0]!.id, 'stub-ws-app');
  assert(resumed, 'resume-session succeeds for a known id');
  assert(state!.activeSessionId === sessions[0]!.id, 'resume marks that session active');
  assert(state!.messages.length > 0, 'resume loads the saved transcript');
  assert(!(await t.catalog.resumeSession('nope', 'stub-ws-app')), 'resume of an unknown id reports false');

  console.log('set-reasoning-effort →');
  await t.send('set-reasoning-effort', { effort: 'high' });
  assert(state!.reasoningEffort === 'high', 'reasoning effort mirrors back through the snapshot');

  t.disconnect();
  assert(status!.status === 'disconnected', 'disconnect reported');

  console.log(failures === 0 ? '\nSTUB SMOKE: PASS' : `\nSTUB SMOKE: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
