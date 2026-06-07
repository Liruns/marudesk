import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Minimal LSP JSON-RPC transport over a child process's stdio (Tier 2,
 * docs/workspace-language-support-design.md). The Language Server Protocol frames
 * each message with a `Content-Length` header then the JSON body; we hand-roll it
 * (no vscode-jsonrpc dependency). Correlates request ids to promises, dispatches
 * server→client notifications, and answers server→client requests with a minimal
 * (null) result so a server that asks for a capability we don't implement isn't
 * left hanging.
 *
 * Pure transport — it knows nothing about LSP methods; the client (client.ts)
 * owns initialize / document sync / publishDiagnostics.
 */

type RpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void };

const HEADER_SEPARATOR = '\r\n\r\n';

export class JsonRpcConnection {
  private buffer = Buffer.alloc(0);
  private contentLength = -1;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
  private readonly requestHandlers = new Map<string, (params: unknown) => unknown>();
  private closed = false;
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Register a responder for a server→client request (return the result value). */
  onRequest(method: string, handler: (params: unknown) => unknown): void {
    this.requestHandlers.set(method, handler);
  }

  sendNotification(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  sendRequest(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('connection closed'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private write(message: RpcMessage): void {
    if (this.closed) return;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}${HEADER_SEPARATOR}`, 'ascii');
    try {
      this.child.stdin.write(header);
      this.child.stdin.write(body);
    } catch {
      // stdin closed (server exited) — handled by the manager's close detection.
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.contentLength < 0) {
        const idx = this.buffer.indexOf(HEADER_SEPARATOR);
        if (idx < 0) return; // headers not fully arrived yet
        const header = this.buffer.subarray(0, idx).toString('ascii');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        this.contentLength = match ? Number(match[1]) : 0;
        this.buffer = this.buffer.subarray(idx + HEADER_SEPARATOR.length);
      }
      if (this.buffer.length < this.contentLength) return; // body incomplete
      const body = this.buffer.subarray(0, this.contentLength).toString('utf8');
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;
      this.dispatch(body);
    }
  }

  private dispatch(body: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(body) as RpcMessage;
    } catch {
      return; // malformed frame — skip
    }

    // Response to one of our requests.
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const id = typeof message.id === 'number' ? message.id : Number(message.id);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (message.error) entry.reject(new Error(message.error.message ?? 'LSP error'));
      else entry.resolve(message.result);
      return;
    }

    // Server→client request (has id + method): answer with the handler's result or null.
    if (message.id !== undefined && message.method) {
      const handler = this.requestHandlers.get(message.method);
      const result = handler ? handler(message.params) : null;
      this.write({ jsonrpc: '2.0', id: message.id, result: result ?? null });
      return;
    }

    // Notification.
    if (message.method) {
      this.notificationHandlers.get(message.method)?.(message.params);
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(new Error('connection closed'));
    this.pending.clear();
  }
}
