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
  /** Optional LSP initializationOptions passed verbatim at initialize. */
  initializationOptions?: unknown;
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

/** A 1-based caret the agent supplies; converted to LSP's 0-based wire position. */
export type LspRequestPosition = { line: number; character: number };

/** A `textDocument/definition` | `references` location (uri + range). */
export type LspLocation = { uri?: string; range?: LspRange };
/** A `textDocument/hover` result — MarkupContent | MarkedString | string | null. */
export type LspHover = unknown;
/** A `textDocument/prepareRename` result — Range | { range } | { defaultBehavior } | null. */
export type LspPrepareRename = unknown;
/** A `textDocument/rename` result — a WorkspaceEdit (or null). */
export type LspWorkspaceEdit = unknown;
/** A `textDocument/documentSymbol` result — DocumentSymbol[] | SymbolInformation[] | null. */
export type LspDocumentSymbols = unknown;

function severityOf(n: number | undefined): DiagnosticSeverity {
  if (n === 1) return 'error';
  if (n === 2) return 'warning';
  return 'info'; // 3 = information, 4 = hint
}

/**
 * `textDocument/definition` and `references` each answer with one of several
 * shapes: a single Location, a Location[], or a LocationLink[] (the latter uses
 * `targetUri`/`targetRange`). Normalize them all to a flat {@link LspLocation}[]
 * so callers handle one shape. Anything unrecognized → empty list (never throw).
 */
function normalizeLocations(result: unknown): LspLocation[] {
  const items = Array.isArray(result) ? result : result ? [result] : [];
  const out: LspLocation[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.uri === 'string') {
      out.push({ uri: o.uri, range: o.range as LspRange | undefined });
    } else if (typeof o.targetUri === 'string') {
      // LocationLink: prefer the selection range, fall back to the full target range.
      out.push({
        uri: o.targetUri,
        range: (o.targetSelectionRange ?? o.targetRange) as LspRange | undefined,
      });
    }
  }
  return out;
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
      ...(this.opts.initializationOptions !== undefined
        ? { initializationOptions: this.opts.initializationOptions }
        : {}),
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false },
          publishDiagnostics: { relatedInformation: false },
          // Declare the request features the agent tools (LSP-1) exercise so the
          // server advertises + answers them. All backward-compatible: a server
          // that doesn't implement one simply ignores the capability and replies
          // with null / a method-not-found error, which the callers handle.
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
          },
          rename: { dynamicRegistration: false, prepareSupport: true },
          hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
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

  /**
   * Build the `{ textDocument, position }` params every position-based request
   * shares, converting the agent's 1-based line/character to LSP's 0-based wire
   * position. Throws if the connection isn't ready so a disposed/errored client
   * returns a clean error instead of a silent no-op.
   */
  private positionParams(file: string, pos: LspRequestPosition): {
    textDocument: { uri: string };
    position: { line: number; character: number };
  } {
    if (!this.conn || !this.ready) throw new Error('LSP server is not ready');
    return {
      textDocument: { uri: this.uriFor(file) },
      position: { line: pos.line - 1, character: pos.character - 1 },
    };
  }

  /** `textDocument/definition` — the symbol's declaration site(s). */
  async definition(file: string, pos: LspRequestPosition): Promise<LspLocation[]> {
    const params = this.positionParams(file, pos);
    const result = await this.conn!.sendRequest('textDocument/definition', params, 20_000);
    return normalizeLocations(result);
  }

  /** `textDocument/references` — every use site (declaration included). */
  async references(file: string, pos: LspRequestPosition): Promise<LspLocation[]> {
    const params = {
      ...this.positionParams(file, pos),
      context: { includeDeclaration: true },
    };
    const result = await this.conn!.sendRequest('textDocument/references', params, 20_000);
    return normalizeLocations(result);
  }

  /** `textDocument/hover` — docs/signature at the caret (deferred from the agent surface). */
  async hover(file: string, pos: LspRequestPosition): Promise<LspHover> {
    const params = this.positionParams(file, pos);
    return this.conn!.sendRequest('textDocument/hover', params, 10_000);
  }

  /** `textDocument/prepareRename` — whether the symbol at the caret can be renamed. */
  async prepareRename(file: string, pos: LspRequestPosition): Promise<LspPrepareRename> {
    const params = this.positionParams(file, pos);
    return this.conn!.sendRequest('textDocument/prepareRename', params, 10_000);
  }

  /** `textDocument/rename` — the WorkspaceEdit that renames the symbol to `newName`. */
  async rename(file: string, pos: LspRequestPosition, newName: string): Promise<LspWorkspaceEdit> {
    const params = { ...this.positionParams(file, pos), newName };
    return this.conn!.sendRequest('textDocument/rename', params, 20_000);
  }

  /** `textDocument/documentSymbol` — the symbol tree (or flat list) for one file. */
  async documentSymbols(file: string): Promise<LspDocumentSymbols> {
    if (!this.conn || !this.ready) throw new Error('LSP server is not ready');
    return this.conn.sendRequest(
      'textDocument/documentSymbol',
      { textDocument: { uri: this.uriFor(file) } },
      20_000,
    );
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
