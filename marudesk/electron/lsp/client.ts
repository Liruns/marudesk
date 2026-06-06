import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { inheritSafeEnv } from '../proc-env';
import { JsonRpcConnection } from './jsonrpc';
import type { Diagnostic, DiagnosticSeverity } from '../../shared/diagnostics';

/**
 * One language-server connection for a (workspace root × server) pair (Tier 2).
 * Spawns the server, runs the LSP `initialize` handshake, mirrors open editor
 * documents to it (full-text sync — simplest + correct), and turns the server's
 * `textDocument/publishDiagnostics` pushes into our {@link Diagnostic} shape. The
 * manager (manager.ts) owns lifecycle; this owns one connection's protocol.
 *
 * Never throws on a bad server: a spawn/exit failure surfaces via onClose so the
 * manager can mark it errored and move on — same graceful posture as MCP.
 */

export type LspClientOptions = {
  /** Full shell command, e.g. "npx --no-install typescript-language-server --stdio". */
  command: string;
  /** Absolute workspace root. */
  root: string;
  /** LSP languageId for opened documents, e.g. "typescript". */
  languageId: string;
  /** Diagnostic.source label for findings (usually the server id). */
  source: string;
  /** Called with workspace-relative POSIX file + its current diagnostics. */
  onDiagnostics: (file: string, diagnostics: Diagnostic[]) => void;
  /** Called once when the connection drops (crash/exit) or fails to start. */
  onClose: (err?: Error) => void;
};

type LspPosition = { line?: number; character?: number };
type LspRange = { start?: LspPosition; end?: LspPosition };
type LspDiagnostic = {
  range?: LspRange;
  severity?: number;
  code?: string | number;
  message?: string;
  source?: string;
};
type PublishParams = { uri?: string; diagnostics?: LspDiagnostic[] };

function severityOf(n: number | undefined): DiagnosticSeverity {
  if (n === 1) return 'error';
  if (n === 2) return 'warning';
  return 'info'; // 3 = information, 4 = hint
}

export class LspClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private conn: JsonRpcConnection | null = null;
  private readonly versions = new Map<string, number>();
  private ready = false;
  private readonly opts: LspClientOptions;

  constructor(opts: LspClientOptions) {
    this.opts = opts;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Spawn + initialize. Resolves once the server is ready for document sync. */
  async start(): Promise<void> {
    const child = spawn(this.opts.command, {
      cwd: this.opts.root,
      env: inheritSafeEnv(),
      shell: true,
    });
    this.child = child;
    child.on('error', (err) => this.handleClose(err));
    child.on('exit', () => this.handleClose());
    child.stderr.on('data', () => {
      /* drain server logs */
    });

    const conn = new JsonRpcConnection(child);
    this.conn = conn;
    conn.onNotification('textDocument/publishDiagnostics', (params) => this.onPublish(params));
    // Minimal answers so a server waiting on these doesn't stall.
    conn.onRequest('window/workDoneProgress/create', () => null);
    conn.onRequest('client/registerCapability', () => null);
    conn.onRequest('workspace/configuration', (params) => {
      const items = (params as { items?: unknown[] } | undefined)?.items;
      return Array.isArray(items) ? items.map(() => null) : [];
    });

    await conn.sendRequest('initialize', this.initializeParams(), 30_000);
    conn.sendNotification('initialized', {});
    this.ready = true;
  }

  private initializeParams(): unknown {
    const rootUri = pathToFileURL(this.opts.root).href;
    return {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.opts.root) }],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false },
          publishDiagnostics: { relatedInformation: false },
        },
        workspace: { workspaceFolders: true, configuration: true },
      },
    };
  }

  private uriFor(file: string): string {
    return pathToFileURL(path.join(this.opts.root, file)).href;
  }

  private fileFromUri(uri: string): string {
    try {
      const abs = fileURLToPath(uri);
      return path.relative(this.opts.root, abs).replace(/\\/g, '/');
    } catch {
      return uri;
    }
  }

  didOpen(file: string, text: string): void {
    this.versions.set(file, 1);
    this.conn?.sendNotification('textDocument/didOpen', {
      textDocument: { uri: this.uriFor(file), languageId: this.opts.languageId, version: 1, text },
    });
  }

  didChange(file: string, text: string): void {
    const version = (this.versions.get(file) ?? 1) + 1;
    this.versions.set(file, version);
    this.conn?.sendNotification('textDocument/didChange', {
      textDocument: { uri: this.uriFor(file), version },
      contentChanges: [{ text }],
    });
  }

  didClose(file: string): void {
    this.versions.delete(file);
    this.conn?.sendNotification('textDocument/didClose', {
      textDocument: { uri: this.uriFor(file) },
    });
  }

  /** Files currently open against this server. */
  openFiles(): string[] {
    return [...this.versions.keys()];
  }

  private onPublish(params: unknown): void {
    const p = params as PublishParams;
    if (!p || typeof p.uri !== 'string') return;
    const file = this.fileFromUri(p.uri);
    const raw = Array.isArray(p.diagnostics) ? p.diagnostics : [];
    const diagnostics: Diagnostic[] = raw.map((d) => {
      const start = d.range?.start ?? {};
      const end = d.range?.end ?? {};
      return {
        file,
        line: (start.line ?? 0) + 1,
        column: (start.character ?? 0) + 1,
        endLine: end.line !== undefined ? end.line + 1 : undefined,
        endColumn: end.character !== undefined ? end.character + 1 : undefined,
        severity: severityOf(d.severity),
        code: d.code !== undefined ? String(d.code) : undefined,
        message: typeof d.message === 'string' ? d.message : '',
        source: d.source ?? this.opts.source,
      };
    });
    this.opts.onDiagnostics(file, diagnostics);
  }

  private handleClose(err?: Error): void {
    if (!this.ready && !this.child) return;
    this.ready = false;
    this.conn?.dispose();
    this.conn = null;
    this.opts.onClose(err);
  }

  dispose(): void {
    this.ready = false;
    this.conn?.dispose();
    this.conn = null;
    try {
      this.child?.kill();
    } catch {
      /* already gone */
    }
    this.child = null;
  }
}
