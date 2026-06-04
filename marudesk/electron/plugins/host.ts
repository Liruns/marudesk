import { scrubText } from '../../shared/scrub';
import {
  PLUGIN_CALL_TIMEOUT_MS,
  PLUGIN_LOAD_TIMEOUT_MS,
  PLUGIN_MAX_TOOL_TEXT,
  PLUGIN_SERVER_PREFIX,
  pluginToolName,
  type PluginContributions,
  type PluginPermission,
  type WorkerPermissionRequest,
  type WorkerToHost,
} from '../../shared/plugin';
import type { McpServer } from '../agent/mcp';
import type { McpTool, ToolContext, ToolResult } from '../agent/tools';
import { guardedFetch, guardedList, guardedRead } from './permissions';
import type { HostChannel } from './rpc';
import { makeIdGen } from './rpc';

/**
 * PluginHost — drives one worker (one plugin) over a {@link HostChannel}
 * (docs/plugin-runtime-design.md §3). It owns the load handshake, routes the
 * model's tool calls to the worker as id-correlated `callTool` RPCs, and fulfils
 * the worker's `ctx.fs` / `ctx.http` permission RPCs against the ORIGINATING
 * call's {@link ToolContext} (resolved by `callId`, the §R2 concurrency fix).
 *
 * Mirrors the external-MCP connector: a thrown error / timeout becomes an error
 * ToolResult so one bad call can't break the turn, and the whole thing sits behind
 * the {@link McpServer} merge point so the loop mediates a plugin tool exactly like
 * a built-in one.
 */

type PendingCall = {
  resolve(text: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** The surface {@link buildPluginServer} needs — injectable for the harness. */
export type PluginHostLike = {
  callTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult>;
};

export class PluginHost implements PluginHostLike {
  private readonly nextId = makeIdGen();
  private readonly pending = new Map<number, PendingCall>();
  /** ToolContext per in-flight callId — the only contexts fs/net RPCs may use. */
  private readonly inflight = new Map<string, ToolContext>();
  private readonly disposers: Array<() => void> = [];
  private loadDone: { resolve(c: PluginContributions): void; reject(e: Error): void } | null = null;
  private disposed = false;
  private readonly channel: HostChannel;
  private readonly pluginId: string;

  constructor(channel: HostChannel, pluginId: string) {
    this.channel = channel;
    this.pluginId = pluginId;
    this.disposers.push(channel.onMessage((msg) => this.onMessage(msg)));
    this.disposers.push(
      channel.onClose(() => {
        if (!this.disposed) this.failAll(new Error('plugin worker exited'));
      }),
    );
  }

  /** Send the load request and await the worker's `ready` (or `loadError`). */
  load(pluginDir: string, main: string, granted: PluginPermission[]): Promise<PluginContributions> {
    return new Promise<PluginContributions>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.loadDone = null;
        reject(new Error('plugin load timed out'));
      }, PLUGIN_LOAD_TIMEOUT_MS);
      this.loadDone = {
        resolve: (c) => {
          clearTimeout(timer);
          resolve(c);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.channel.postMessage({ kind: 'load', pluginDir, main, granted });
    });
  }

  /** Route one tool call to the worker; map result/timeout into a string. */
  private callWorker(name: string, callId: string, input: unknown): Promise<string> {
    const id = this.nextId();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('plugin tool timed out'));
      }, PLUGIN_CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.channel.postMessage({ kind: 'callTool', id, name, callId, input });
    });
  }

  /** PluginHostLike: execute a plugin tool, registering its ToolContext by callId. */
  async callTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const callId = `${this.pluginId}:${this.nextId()}`;
    this.inflight.set(callId, ctx);
    try {
      let text = await this.callWorker(name, callId, input ?? {});
      if (text.length > PLUGIN_MAX_TOOL_TEXT) {
        text = `${text.slice(0, PLUGIN_MAX_TOOL_TEXT)}\n…[clipped ${text.length - PLUGIN_MAX_TOOL_TEXT} chars]`;
      }
      return { summary: name, text: scrubText(text) || '(no content)' };
    } catch (err) {
      return {
        summary: `${name} error`,
        text: `${name} failed — ${scrubText((err as Error).message)}`,
        isError: true,
      };
    } finally {
      this.inflight.delete(callId);
    }
  }

  private async onMessage(msg: WorkerToHost): Promise<void> {
    switch (msg.kind) {
      case 'ready':
        this.loadDone?.resolve(msg.contributions);
        this.loadDone = null;
        break;
      case 'loadError':
        this.loadDone?.reject(new Error(msg.error));
        this.loadDone = null;
        break;
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) break;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.text);
        else p.reject(new Error(msg.error));
        break;
      }
      case 'log':
        console.log(`[plugin:${this.pluginId}] ${scrubText(msg.message)}`);
        break;
      case 'perm':
        await this.handlePerm(msg);
        break;
    }
  }

  /** Fulfil a worker permission RPC against the originating call's ToolContext. */
  private async handlePerm(msg: WorkerPermissionRequest): Promise<void> {
    const ctx = this.inflight.get(msg.callId);
    if (!ctx) {
      this.channel.postMessage({ kind: 'resolve', id: msg.id, ok: false, error: 'no active tool call for this request' });
      return;
    }
    try {
      let value: unknown;
      if (msg.op === 'fs.read') value = await guardedRead(ctx, msg.path);
      else if (msg.op === 'fs.list') value = await guardedList(ctx, msg.path);
      else value = await guardedFetch();
      this.channel.postMessage({ kind: 'resolve', id: msg.id, ok: true, value });
    } catch (err) {
      this.channel.postMessage({ kind: 'resolve', id: msg.id, ok: false, error: scrubText((err as Error).message) });
    }
  }

  private failAll(error: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.loadDone?.reject(error);
    this.loadDone = null;
  }

  /** Tear down: reject in-flight RPCs immediately (no 60s wait) and kill the worker. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error('plugin disabled'));
    try {
      this.channel.postMessage({ kind: 'deactivate' });
    } catch {
      // worker may already be gone
    }
    for (const off of this.disposers) off();
    this.channel.kill();
  }
}

/**
 * Wrap a plugin's contributed tools as namespaced {@link McpTool}s whose `exec`
 * delegates to the host over RPC — the plugin analogue of buildExternalServer.
 * `group: 'plugin'`, `gated: true` (third-party, side-effecting → user approves),
 * NOT `write` (gating is the control, same rationale as external MCP).
 */
export function buildPluginServer(
  pluginId: string,
  host: PluginHostLike,
  contributions: PluginContributions,
): McpServer {
  const tools: McpTool[] = contributions.tools.map((t) => {
    const namespaced = pluginToolName(pluginId, t.name);
    return {
      name: namespaced,
      description: t.description ? `[${pluginId}] ${t.description}` : `[${pluginId}] plugin tool "${t.name}".`,
      inputSchema: t.inputSchema,
      group: 'plugin',
      gated: true,
      exec: (input, ctx): Promise<ToolResult> => host.callTool(t.name, input, ctx),
    };
  });
  return { name: `${PLUGIN_SERVER_PREFIX}${pluginId}`, tools };
}
