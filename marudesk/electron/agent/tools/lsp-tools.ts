import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_FILE_PATTERN as SECRET_FILE } from '../../../shared/secret-files';
import { readFileWindow } from '../../workspace';
import { getReadyClientsForFile } from '../../lsp/manager';
import type { LspClient, LspLocation } from '../../lsp/client';
import { applyEdits, type EditOp } from './file-tools';
import type { ToolContext, ToolResult } from './types';

/**
 * LSP-backed agent tools (docs/agent-port-plan.md LSP-1) — code navigation and a
 * gated, edit-safe rename built on the running language-server manager.
 *
 *  - lsp_navigate (definition | references) and lsp_symbols are READ-ONLY: they
 *    query a ready {@link LspClient} for `root` + file extension and format the
 *    result as `relPath:line:col` / a symbol tree. No ready server for the file
 *    type → a graceful error result (never a throw), same posture as the file
 *    tools' no-workspace path.
 *  - lsp_rename is a WRITE tool (GATED). It runs `prepareRename` first (refuses
 *    when the symbol can't be renamed), then `rename`, then converts the returned
 *    WorkspaceEdit into edit ops and applies them THROUGH the exported
 *    {@link applyEdits} — so the SAME SECRET_FILE / denyGlobs / staleness / atomic
 *    guards that protect edit_file also protect a rename. It never writes files
 *    directly.
 *
 * Deferred from this first slice (per the doc): a standalone lsp_hover tool (the
 * LspClient.hover method exists, but is not yet surfaced) and workspace-scope
 * symbol search (lsp_symbols is document-scope only).
 */

const DEFINITION_CAP = 10;
const REFERENCES_CAP = 50;
const SYMBOL_CAP = 200;

/** LSP ranges are 0-based; the agent surface speaks 1-based line/column. */
type LspPosition = { line?: number; character?: number };
type LspRange = { start?: LspPosition; end?: LspPosition };

/** Uniform "no ready language server" result — a graceful error, not a throw. */
function noServerResult(tool: string): ToolResult {
  return {
    summary: `${tool} (no LSP server)`,
    text: 'No ready LSP server for this file type. A language server must be configured for this extension (Settings → languages.json) and finished starting before navigation/rename works.',
    isError: true,
  };
}

/** First ready client for `file`, or null when none handles its extension yet. */
function firstReadyClient(root: string, file: string): LspClient | null {
  const clients = getReadyClientsForFile(root, file);
  return clients.length > 0 ? clients[0] : null;
}

/** Convert an LSP location's uri + 0-based range to `relPath:line:col` (1-based). */
function formatLocation(loc: LspLocation, root: string): string | null {
  if (typeof loc.uri !== 'string') return null;
  let rel: string;
  try {
    rel = path.relative(root, fileURLToPath(loc.uri)).replace(/\\/g, '/');
  } catch {
    rel = loc.uri;
  }
  const start = (loc.range as LspRange | undefined)?.start ?? {};
  const line = (start.line ?? 0) + 1;
  const col = (start.character ?? 0) + 1;
  return `${rel}:${line}:${col}`;
}

function asInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null;
}

export async function lspNavigate(
  input: { path?: unknown; line?: unknown; character?: unknown; kind?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.ws) {
    return {
      summary: 'lsp_navigate (no workspace)',
      text: 'No folder is open, so LSP navigation is unavailable. Ask the user to open a workspace (Explorer → Open Folder).',
      isError: true,
    };
  }
  const file = typeof input.path === 'string' ? input.path : '';
  const line = asInt(input.line);
  const character = asInt(input.character);
  const kind = input.kind === 'references' ? 'references' : 'definition';
  if (!file || line === null || character === null) {
    throw new Error('lsp_navigate requires "path", 1-based "line", and 1-based "character"');
  }

  const client = firstReadyClient(ctx.ws.root, file);
  if (!client) return noServerResult('lsp_navigate');

  const locations =
    kind === 'references'
      ? await client.references(file, { line, character })
      : await client.definition(file, { line, character });

  const cap = kind === 'references' ? REFERENCES_CAP : DEFINITION_CAP;
  const formatted: string[] = [];
  for (const loc of locations) {
    const f = formatLocation(loc, ctx.ws.root);
    if (f) formatted.push(f);
    if (formatted.length >= cap) break;
  }

  if (formatted.length === 0) {
    return {
      summary: `lsp_navigate ${kind} → none`,
      text: `No ${kind} found at ${file}:${line}:${character}.`,
    };
  }
  const note = locations.length > formatted.length ? `\n…(showing ${formatted.length} of ${locations.length})` : '';
  return {
    summary: `lsp_navigate ${kind} → ${formatted.length}`,
    text: formatted.join('\n') + note,
  };
}

/* ── lsp_symbols ─────────────────────────────────────────────────────────── */

/** Hierarchical DocumentSymbol (preferred) — has nested `children` + `range`. */
type DocumentSymbol = {
  name?: unknown;
  kind?: unknown;
  range?: LspRange;
  selectionRange?: LspRange;
  children?: unknown;
};
/** Flat SymbolInformation fallback — `location` instead of an inline `range`. */
type SymbolInformation = { name?: unknown; kind?: unknown; location?: { range?: LspRange } };

const SYMBOL_KINDS: Record<number, string> = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method',
  7: 'property', 8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface',
  12: 'function', 13: 'variable', 14: 'constant', 15: 'string', 16: 'number',
  17: 'boolean', 18: 'array', 19: 'object', 20: 'key', 21: 'null',
  22: 'enum-member', 23: 'struct', 24: 'event', 25: 'operator', 26: 'type-parameter',
};

function kindLabel(kind: unknown): string {
  return typeof kind === 'number' && SYMBOL_KINDS[kind] ? SYMBOL_KINDS[kind] : 'symbol';
}

/** Recursively render a DocumentSymbol tree (indented), capped at SYMBOL_CAP lines. */
function renderSymbolTree(symbols: DocumentSymbol[], depth: number, out: string[]): void {
  for (const sym of symbols) {
    if (out.length >= SYMBOL_CAP) return;
    const name = typeof sym.name === 'string' ? sym.name : '(anonymous)';
    const line = (sym.selectionRange?.start?.line ?? sym.range?.start?.line ?? 0) + 1;
    out.push(`${'  '.repeat(depth)}${kindLabel(sym.kind)} ${name} (line ${line})`);
    if (Array.isArray(sym.children)) renderSymbolTree(sym.children as DocumentSymbol[], depth + 1, out);
  }
}

function isDocumentSymbol(v: unknown): v is DocumentSymbol {
  return !!v && typeof v === 'object' && 'range' in (v as object) && !('location' in (v as object));
}

export async function lspSymbols(input: { path?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.ws) {
    return {
      summary: 'lsp_symbols (no workspace)',
      text: 'No folder is open, so LSP symbols are unavailable. Ask the user to open a workspace (Explorer → Open Folder).',
      isError: true,
    };
  }
  const file = typeof input.path === 'string' ? input.path : '';
  if (!file) throw new Error('lsp_symbols requires "path"');

  const client = firstReadyClient(ctx.ws.root, file);
  if (!client) return noServerResult('lsp_symbols');

  const result = await client.documentSymbols(file);
  const list = Array.isArray(result) ? result : [];
  const out: string[] = [];
  if (list.length > 0 && isDocumentSymbol(list[0])) {
    renderSymbolTree(list as DocumentSymbol[], 0, out);
  } else {
    // SymbolInformation[] fallback — flat, with a location range per symbol.
    for (const item of list as SymbolInformation[]) {
      if (out.length >= SYMBOL_CAP) break;
      const name = typeof item.name === 'string' ? item.name : '(anonymous)';
      const lineNum = (item.location?.range?.start?.line ?? 0) + 1;
      out.push(`${kindLabel(item.kind)} ${name} (line ${lineNum})`);
    }
  }

  if (out.length === 0) {
    return { summary: `lsp_symbols ${file} → none`, text: `No symbols reported for ${file}.` };
  }
  const note = list.length > out.length ? `\n…(capped at ${SYMBOL_CAP} symbols)` : '';
  return { summary: `lsp_symbols ${file} → ${out.length}`, text: out.join('\n') + note };
}

/* ── lsp_rename ──────────────────────────────────────────────────────────── */

/** A WorkspaceEdit's `changes` map (uri → TextEdit[]) and/or `documentChanges`. */
type TextEdit = { range?: LspRange; newText?: unknown };
type WorkspaceEdit = {
  changes?: Record<string, unknown>;
  documentChanges?: unknown;
};

/** Collect per-uri TextEdit[] from a WorkspaceEdit's changes + documentChanges. */
function collectEdits(edit: WorkspaceEdit): Map<string, TextEdit[]> {
  const byUri = new Map<string, TextEdit[]>();
  const add = (uri: string, edits: unknown): void => {
    if (!Array.isArray(edits)) return;
    const list = byUri.get(uri) ?? [];
    for (const e of edits) if (e && typeof e === 'object') list.push(e as TextEdit);
    byUri.set(uri, list);
  };
  if (edit.changes && typeof edit.changes === 'object') {
    for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits);
  }
  if (Array.isArray(edit.documentChanges)) {
    for (const dc of edit.documentChanges) {
      if (!dc || typeof dc !== 'object') continue;
      const o = dc as { textDocument?: { uri?: unknown }; edits?: unknown };
      // Only TextDocumentEdit entries carry edits (create/rename/delete file ops
      // are not applied here — a symbol rename never produces them).
      if (o.textDocument && typeof o.textDocument.uri === 'string') add(o.textDocument.uri, o.edits);
    }
  }
  return byUri;
}

/**
 * Convert one file's TextEdit[] (0-based ranges + newText) into verbatim EditOps
 * against the file's CURRENT on-disk content. Each op's `oldString` is the exact
 * substring the range covers, so applyEdits' staleness guard rejects the rename
 * (and hands back fresh content) if the file changed since the server indexed it.
 * Returns null when any range can't be sliced (out of bounds → let the caller
 * surface a clean error instead of a corrupt edit).
 */
function editsToOps(relPath: string, content: string, edits: TextEdit[]): EditOp[] | null {
  // Offset of the start of each line, so a {line, character} maps to an index.
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') lineStarts.push(i + 1);
  }
  const offsetOf = (pos: LspPosition | undefined): number | null => {
    const line = pos?.line ?? 0;
    const character = pos?.character ?? 0;
    if (line < 0 || line >= lineStarts.length) return null;
    const lineStart = lineStarts[line];
    const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] : content.length;
    const idx = lineStart + character;
    // Clamp into the line (the newline is part of [lineStart, lineEnd)).
    if (idx < lineStart || idx > lineEnd) return null;
    return idx;
  };

  const ops: EditOp[] = [];
  for (const e of edits) {
    const newString = typeof e.newText === 'string' ? e.newText : null;
    if (newString === null) return null;
    const startIdx = offsetOf(e.range?.start);
    const endIdx = offsetOf(e.range?.end);
    if (startIdx === null || endIdx === null || endIdx < startIdx) return null;
    const oldString = content.slice(startIdx, endIdx);
    // Skip a no-op edit (identical text) so it doesn't create an empty-oldString
    // op that applyEdits would misread as a file create.
    if (oldString.length === 0 && newString.length === 0) continue;
    ops.push({ path: relPath, oldString, newString });
  }
  return ops;
}

export async function lspRename(
  input: { path?: unknown; line?: unknown; character?: unknown; newName?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.ws) {
    return {
      summary: 'lsp_rename (no workspace)',
      text: 'No folder is open, so LSP rename is unavailable. Ask the user to open a workspace (Explorer → Open Folder).',
      isError: true,
    };
  }
  const ws = ctx.ws;
  const file = typeof input.path === 'string' ? input.path : '';
  const line = asInt(input.line);
  const character = asInt(input.character);
  const newName = typeof input.newName === 'string' ? input.newName : '';
  if (!file || line === null || character === null || !newName) {
    throw new Error('lsp_rename requires "path", 1-based "line", 1-based "character", and "newName"');
  }

  const client = firstReadyClient(ws.root, file);
  if (!client) return noServerResult('lsp_rename');

  // Prepare first: a null / { defaultBehavior: false } result means the caret is
  // not on a renameable symbol — refuse rather than attempt a bogus rename. A
  // server with no prepareRename answers method-not-found; treat that as "go
  // ahead" (rename itself still validates the position).
  let prepared: unknown;
  try {
    prepared = await client.prepareRename(file, { line, character });
  } catch {
    prepared = undefined; // method not supported — fall through to rename.
  }
  if (prepared === null) {
    return {
      summary: 'lsp_rename (not renameable)',
      text: `The symbol at ${file}:${line}:${character} cannot be renamed here (the server reported no valid rename range).`,
      isError: true,
    };
  }
  if (prepared && typeof prepared === 'object' && (prepared as { defaultBehavior?: unknown }).defaultBehavior === false) {
    return {
      summary: 'lsp_rename (not renameable)',
      text: `The symbol at ${file}:${line}:${character} cannot be renamed (server reported defaultBehavior=false).`,
      isError: true,
    };
  }

  const result = await client.rename(file, { line, character }, newName);
  if (!result || typeof result !== 'object') {
    return {
      summary: 'lsp_rename (no edit)',
      text: `The server returned no rename edit for ${file}:${line}:${character}.`,
      isError: true,
    };
  }

  const byUri = collectEdits(result as WorkspaceEdit);
  if (byUri.size === 0) {
    return {
      summary: 'lsp_rename (no edit)',
      text: `The server returned an empty rename edit for ${file}:${line}:${character}.`,
      isError: true,
    };
  }

  // Convert every affected file's TextEdit[] into verbatim ops against its
  // CURRENT content, then apply them ALL through the gated applyEdits in one
  // atomic batch (SECRET_FILE / denyGlobs / staleness / atomic patch enforced).
  const ops: EditOp[] = [];
  for (const [uri, edits] of byUri) {
    let rel: string;
    try {
      rel = path.relative(ws.root, fileURLToPath(uri)).replace(/\\/g, '/');
    } catch {
      return {
        summary: 'lsp_rename failed',
        text: `The rename touched a file with an unusable uri (${uri}).`,
        isError: true,
      };
    }
    // Don't even read a secret file — applyEdits also blocks it, but failing fast
    // here keeps the error message specific.
    if (SECRET_FILE.test(rel)) {
      return {
        summary: 'lsp_rename blocked',
        text: `Blocked: the rename would edit "${rel}", which looks like a credentials/secret file and cannot be written by the agent.`,
        isError: true,
      };
    }
    let content: string;
    try {
      content = (await readFileWindow(ws.root, rel)).content;
    } catch {
      return {
        summary: 'lsp_rename failed',
        text: `Could not read "${rel}" to apply the rename (it may be outside the workspace or unreadable).`,
        isError: true,
      };
    }
    const fileOps = editsToOps(rel, content, edits);
    if (fileOps === null) {
      return {
        summary: 'lsp_rename failed',
        text: `The rename edit for "${rel}" did not map onto the current file (it may have changed since the server indexed it). Re-open the file and try again.`,
        isError: true,
      };
    }
    ops.push(...fileOps);
  }

  if (ops.length === 0) {
    return { summary: 'lsp_rename (no change)', text: `The rename produced no effective changes for "${newName}".` };
  }
  // ToolResult is returned verbatim so the approval card / revert history (edits)
  // come straight from the gated applyEdits path.
  return applyEdits(ops, ctx, 'lsp_rename');
}
