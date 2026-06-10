import { RelayTransport, toWsUrl } from '../src/transport/RelayTransport.ts';
import { emptyAgentChatState, type AgentChatState } from '../src/types.ts';
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

function fail(msg: string): void {
  failures += 1;
  console.error(`FAIL  ${msg}`);
}

function wait(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  get: () => T,
  pred: (value: T) => boolean,
  label: string,
  timeoutMs = 1_000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = get();
    if (pred(value)) return value;
    await wait();
  }
  fail(`timed out waiting for ${label}`);
  return get();
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type FakeMessageEvent = { data: unknown };

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readonly url: string;

  readyState = FakeWebSocket.OPEN;
  onmessage: ((ev: FakeMessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}

function parseSentMessage(ws: FakeWebSocket, index: number): unknown {
  return JSON.parse(ws.sent[index] ?? 'null') as unknown;
}

function getLatestStatus(statuses: readonly TransportStatusInfo[]): TransportStatusInfo | null {
  return statuses.length === 0 ? null : statuses[statuses.length - 1] ?? null;
}

async function main(): Promise<void> {
  const previousWebSocket = globalThis.WebSocket;
  const fakeWebSocketCtor = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.WebSocket = fakeWebSocketCtor;

  const transport = new RelayTransport();
  const states: AgentChatState[] = [];
  const statuses: TransportStatusInfo[] = [];
  transport.onState((state) => states.push(state));
  transport.onStatus((status) => statuses.push(status));

  try {
    assert(toWsUrl('http://relay.example.com/') === 'ws://relay.example.com', 'http relay URLs become ws');
    assert(
      toWsUrl('https://relay.example.com/base/') === 'wss://relay.example.com/base',
      'https relay URLs become wss and lose the trailing slash',
    );

    await transport.connect('https://relay.example.com/', 'token 123');
    const ws = FakeWebSocket.instances[0];
    if (!ws) {
      fail('connect should construct a WebSocket');
      throw new Error('missing fake socket');
    }

    assert(
      ws.url === 'wss://relay.example.com/connect?role=client&token=token%20123',
      'connect builds the expected relay URL',
    );

    ws.emitMessage(
      JSON.stringify({
        type: 'ready',
        role: 'client',
        accountId: 'acct-1',
        peers: { hosts: 0, clients: 1 },
      }),
    );

    await waitFor(
      () => getLatestStatus(statuses),
      (status) => status?.status === 'connected',
      'relay ready -> connected status',
    );
    assert(getLatestStatus(statuses)?.status === 'connected', 'ready frame transitions the transport to connected');

    await waitFor(() => ws.sent.length, (count) => count >= 1, 'automatic snapshot command');
    const snapshotFrame = parseSentMessage(ws, 0) as { payload?: Record<string, unknown> };
    const snapshotPayload = snapshotFrame.payload ?? {};
    assert(
      Object.keys(snapshotFrame).length === 1 &&
        snapshotPayload.k === 'cmd' &&
        snapshotPayload.cmd === 'snapshot' &&
        sameJson(snapshotPayload.args, {}),
      'ready triggers an automatic snapshot command envelope',
    );
    const snapshotCid = typeof snapshotPayload.cid === 'string' ? snapshotPayload.cid : '';
    ws.emitMessage(
      JSON.stringify({
        type: 'relay',
        from: 'host',
        payload: { k: 'ack', cid: snapshotCid, ok: true },
      }),
    );

    const sendArgs = { provider: 'anthropic', model: 'claude-sonnet-4-6', prompt: 'hello' };
    const okPromise = transport.send('send', sendArgs);
    await waitFor(() => ws.sent.length, (count) => count >= 2, 'send command envelope');

    const sendFrame = parseSentMessage(ws, 1) as { payload?: Record<string, unknown> };
    const sendPayload = sendFrame.payload ?? {};
    assert(
      sameJson(Object.keys(sendFrame).sort(), ['payload']) &&
        sameJson(Object.keys(sendPayload).sort(), ['args', 'cid', 'cmd', 'k']) &&
        sendPayload.k === 'cmd' &&
        sendPayload.cmd === 'send' &&
        sameJson(sendPayload.args, sendArgs),
      'send("send", ...) emits the exact relay command envelope',
    );

    const okCid = typeof sendPayload.cid === 'string' ? sendPayload.cid : '';
    ws.emitMessage(
      JSON.stringify({
        type: 'relay',
        from: 'host',
        payload: { k: 'ack', cid: okCid, ok: true },
      }),
    );
    await okPromise;
    assert(true, 'ok ack resolves the pending send command');

    const rejectPromise = transport.send('send', {
      provider: 'openai',
      model: 'gpt-5',
      prompt: 'deny this one',
    });
    await waitFor(() => ws.sent.length, (count) => count >= 3, 'error ack command envelope');

    const rejectFrame = parseSentMessage(ws, 2) as { payload?: Record<string, unknown> };
    const rejectCid = typeof rejectFrame.payload?.cid === 'string' ? rejectFrame.payload.cid : '';
    ws.emitMessage(
      JSON.stringify({
        type: 'relay',
        from: 'host',
        payload: { k: 'ack', cid: rejectCid, ok: false, error: 'host refused' },
      }),
    );

    try {
      await rejectPromise;
      fail('error ack should reject the pending send command');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assert(message === 'host refused', 'error ack rejects with the host error text');
    }

    const expectedState = emptyAgentChatState();
    expectedState.turnId = 'turn-1';
    expectedState.status = 'working';
    ws.emitMessage(
      JSON.stringify({
        type: 'relay',
        from: 'host',
        payload: { k: 'event', state: expectedState },
      }),
    );

    await waitFor(() => states.length, (count) => count >= 1, 'state event propagation');
    assert(sameJson(states[states.length - 1], expectedState), 'event frames emit the host chat state');

    await wait();
    const stateCount = states.length;
    const statusCount = statuses.length;
    ws.emitMessage('not-json');
    ws.emitMessage(JSON.stringify({ type: 'relay', from: 'host', payload: { k: 'ack', ok: 'bad' } }));
    ws.emitMessage({ type: 'ready' });
    await wait();
    assert(states.length === stateCount, 'malformed frames do not emit chat state');
    assert(statuses.length === statusCount, 'malformed frames do not change transport status');

    transport.disconnect();
    assert(getLatestStatus(statuses)?.status === 'disconnected', 'disconnect reports disconnected');
  } finally {
    transport.disconnect();
    if (previousWebSocket) {
      globalThis.WebSocket = previousWebSocket;
    } else {
      Reflect.deleteProperty(globalThis, 'WebSocket');
    }
  }

  console.log(
    failures === 0
      ? '\nMOBILE RELAY TRANSPORT SMOKE: PASS'
      : `\nMOBILE RELAY TRANSPORT SMOKE: FAIL (${failures})`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
