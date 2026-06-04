/**
 * Plugin worker — the isolated entry point that loads and runs third-party plugin
 * code (docs/plugin-runtime-design.md §3, §3.2). Runs as an Electron
 * `utilityProcess` in production and as a `child_process` in the headless harness;
 * BOTH are plain Node, so this module MUST NOT import `electron` (it talks over
 * `process.parentPort` when present, else `process.send`). Keeping it Electron-free
 * is what lets the harness spawn the very same code via child_process and assert
 * the sandbox (design §R1).
 *
 * Trust model: plugin code is untrusted. Two defenses run BEFORE the plugin is
 * required (§3.2): (1) the production host passes Node Permission Model flags so
 * fs/child_process/worker are denied at the runtime; (2) this module shims
 * `Module._load` to deny network + process-spawning modules unless the `net`
 * permission is granted. The only sanctioned outside access is via `ctx`, every
 * call of which is mediated by the host over RPC and tagged with the originating
 * tool call's id (§R2 concurrency fix) via AsyncLocalStorage.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import type {
  HostToWorker,
  PluginContributions,
  PluginPermission,
  PluginSlashContribution,
  PluginToolContribution,
  WorkerToHost,
} from '../../shared/plugin';

/* ── Outbound channel (parentPort for utilityProcess, process.send for child) ── */

type ParentPort = {
  postMessage(msg: unknown): void;
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
};
const parentPort: ParentPort | undefined = (process as unknown as { parentPort?: ParentPort })
  .parentPort;

function send(msg: WorkerToHost): void {
  if (parentPort) parentPort.postMessage(msg);
  else if (process.send) process.send(msg);
}

function onHostMessage(handler: (msg: HostToWorker) => void): void {
  if (parentPort) parentPort.on('message', (e) => handler(e.data as HostToWorker));
  else process.on('message', (msg) => handler(msg as HostToWorker));
}

/* ── Module shim: deny dangerous core modules unless permitted (§3.2) ────────── */

const NET_MODULES = new Set(['net', 'http', 'https', 'http2', 'dns', 'dns/promises', 'tls']);
// Always denied in v1 (Node Permission Model also blocks these in production; the
// shim makes the denial assertable in the harness, which runs without the flags).
const ALWAYS_DENIED = new Set(['child_process', 'worker_threads', 'cluster', 'vm', 'inspector']);

function installModuleShim(granted: PluginPermission[]): void {
  const allowNet = granted.includes('net');
  const internal = Module as unknown as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
  };
  const original = internal._load.bind(internal);
  internal._load = (request: string, parent: unknown, isMain: boolean): unknown => {
    const bare = request.startsWith('node:') ? request.slice(5) : request;
    if (ALWAYS_DENIED.has(bare)) {
      throw new Error(`plugin sandbox: module "${request}" is not permitted`);
    }
    if (!allowNet && NET_MODULES.has(bare)) {
      throw new Error(`plugin sandbox: module "${request}" requires the "net" permission`);
    }
    return original(request, parent, isMain);
  };
}

/* ── Permission RPC (worker → host); each tagged with the in-flight callId ────── */

let permId = 0;
const pendingPerms = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
/** Carries the active tool call's id across the (async) handler (§R2). */
const callStore = new AsyncLocalStorage<{ callId: string }>();

function requirePermContext(op: string): string {
  const store = callStore.getStore();
  if (!store) {
    throw new Error(`plugin sandbox: ${op} is only available inside a tool handler`);
  }
  return store.callId;
}

function permRpc(message: (id: number, callId: string) => WorkerToHost, op: string): Promise<unknown> {
  const callId = requirePermContext(op);
  const id = (permId += 1);
  return new Promise<unknown>((resolve, reject) => {
    pendingPerms.set(id, { resolve, reject });
    send(message(id, callId));
  });
}

/* ── ctx — the only surface plugin code gets ─────────────────────────────────── */

type PluginToolDef = PluginToolContribution & {
  handler(input: unknown): Promise<string | { text: string }> | string | { text: string };
};

type BuiltContext = {
  ctx: Record<string, unknown>;
  tools: Map<string, PluginToolDef>;
  commands: PluginSlashContribution[];
  seal(): void;
};

function makeContext(granted: PluginPermission[]): BuiltContext {
  const tools = new Map<string, PluginToolDef>();
  const commands: PluginSlashContribution[] = [];
  let sealed = false;

  const ctx: Record<string, unknown> = {
    registerTool(def: PluginToolDef) {
      if (sealed) throw new Error('registerTool must be called during activate');
      if (!granted.includes('tools')) throw new Error('plugin: "tools" permission not granted');
      if (!def || typeof def.name !== 'string' || typeof def.handler !== 'function') {
        throw new Error('registerTool: name and handler are required');
      }
      tools.set(def.name, def);
    },
    registerSlashCommand(def: PluginSlashContribution) {
      if (sealed) throw new Error('registerSlashCommand must be called during activate');
      if (!granted.includes('commands')) throw new Error('plugin: "commands" permission not granted');
      if (!def || typeof def.name !== 'string' || typeof def.template !== 'string') {
        throw new Error('registerSlashCommand: name and template are required');
      }
      commands.push({
        name: def.name,
        description: def.description ?? '',
        argHint: def.argHint,
        template: def.template,
      });
    },
    fs: {
      read(relPath: string): Promise<string> {
        if (!granted.includes('fs:read')) throw new Error('plugin: "fs:read" permission not granted');
        return permRpc((id, callId) => ({ kind: 'perm', id, op: 'fs.read', callId, path: relPath }), 'fs.read') as Promise<string>;
      },
      list(relPath: string): Promise<string[]> {
        if (!granted.includes('fs:read')) throw new Error('plugin: "fs:read" permission not granted');
        return permRpc((id, callId) => ({ kind: 'perm', id, op: 'fs.list', callId, path: relPath }), 'fs.list') as Promise<string[]>;
      },
    },
    http: {
      fetch(url: string): Promise<{ status: number; text: string }> {
        if (!granted.includes('net')) throw new Error('plugin: "net" permission not granted');
        return permRpc((id, callId) => ({ kind: 'perm', id, op: 'http.fetch', callId, url }), 'http.fetch') as Promise<{ status: number; text: string }>;
      },
    },
    log(...args: unknown[]) {
      const message = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
      send({ kind: 'log', level: 'info', message });
    },
  };

  return {
    ctx,
    tools,
    commands,
    seal() {
      sealed = true;
    },
  };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/* ── Lifecycle ───────────────────────────────────────────────────────────────── */

let toolMap: Map<string, PluginToolDef> = new Map();

async function load(msg: Extract<HostToWorker, { kind: 'load' }>): Promise<void> {
  try {
    installModuleShim(msg.granted);
    const built = makeContext(msg.granted);
    const require = createRequire(path.join(msg.pluginDir, 'package.json'));
    const entry = path.resolve(msg.pluginDir, msg.main);
    if (!entry.startsWith(path.resolve(msg.pluginDir) + path.sep)) {
      throw new Error('plugin main escapes the plugin folder');
    }
    const mod = require(entry) as { activate?: (ctx: unknown) => unknown };
    if (typeof mod.activate !== 'function') throw new Error('plugin has no activate(ctx) export');
    await mod.activate(built.ctx);
    built.seal();
    toolMap = built.tools;
    const contributions: PluginContributions = {
      tools: [...built.tools.values()].map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
      commands: built.commands,
    };
    send({ kind: 'ready', contributions });
  } catch (err) {
    send({ kind: 'loadError', error: (err as Error).message });
  }
}

async function callTool(msg: Extract<HostToWorker, { kind: 'callTool' }>): Promise<void> {
  const tool = toolMap.get(msg.name);
  if (!tool) {
    send({ kind: 'result', id: msg.id, ok: false, error: `unknown tool: ${msg.name}` });
    return;
  }
  try {
    const out = await callStore.run({ callId: msg.callId }, async () => tool.handler(msg.input));
    const text = typeof out === 'string' ? out : typeof out?.text === 'string' ? out.text : safeStringify(out);
    send({ kind: 'result', id: msg.id, ok: true, text });
  } catch (err) {
    send({ kind: 'result', id: msg.id, ok: false, error: (err as Error).message });
  }
}

onHostMessage((msg) => {
  switch (msg.kind) {
    case 'load':
      void load(msg);
      break;
    case 'callTool':
      void callTool(msg);
      break;
    case 'resolve': {
      const pending = pendingPerms.get(msg.id);
      if (!pending) break;
      pendingPerms.delete(msg.id);
      if (msg.ok) pending.resolve(msg.value);
      else pending.reject(new Error(msg.error));
      break;
    }
    case 'deactivate':
      process.exit(0);
      break;
  }
});
