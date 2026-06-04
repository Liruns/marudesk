import type { HostToWorker, WorkerToHost } from '../../shared/plugin';
import { stripProtoKeys } from '../../shared/plugin';

/**
 * Transport-agnostic message channel for the plugin host↔worker link
 * (docs/plugin-runtime-design.md §3). The host runs a worker either as an
 * Electron `utilityProcess` (production) or a `child_process` (headless harness);
 * both expose a structured-message channel. {@link MessageChannelLike} is the only
 * surface the RPC layer needs, so transport.ts can adapt either backend and the
 * harness can inject a mock — the same `McpClientLike` seam the external-MCP
 * connector uses.
 *
 * Incoming payloads are run through {@link stripProtoKeys} before any consumer
 * sees them, so a malicious worker can't smuggle `__proto__` pollution across the
 * boundary.
 */

/** The minimal duplex channel a transport must provide. */
export type MessageChannelLike<TX, RX> = {
  postMessage(message: TX): void;
  /** Register the single message listener; returns a disposer. */
  onMessage(listener: (message: RX) => void): () => void;
  /** Register an exit/close listener; returns a disposer. */
  onClose(listener: () => void): () => void;
  /** Terminate the underlying process/channel. */
  kill(): void;
};

/** The host's view of the channel: it sends HostToWorker, receives WorkerToHost. */
export type HostChannel = MessageChannelLike<HostToWorker, WorkerToHost>;

/** The worker's view: it sends WorkerToHost, receives HostToWorker. */
export type WorkerChannel = MessageChannelLike<WorkerToHost, HostToWorker>;

/**
 * A pending id-correlated request. The host uses this for `callTool` (awaiting a
 * `result`); the worker uses it for permission RPCs (awaiting a `resolve`). Both
 * directions share the same id space per side, so a monotonic counter suffices.
 */
export type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** Allocate sequential request ids (per side). */
export function makeIdGen(): () => number {
  let n = 0;
  return () => (n += 1);
}

/**
 * Wrap a raw listener so every received message is proto-stripped first. Used by
 * both sides when attaching their handler, keeping the guard in one place.
 */
export function guardedListener<RX>(handler: (message: RX) => void): (raw: RX) => void {
  return (raw: RX) => handler(stripProtoKeys(raw));
}
