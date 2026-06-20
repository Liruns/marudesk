import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkspaceSummary } from '../../shared/workspace.ts';
import type { ToolContext } from '../agent/tools/types.ts';
import { lspNavigate, lspSymbols, lspRename } from '../agent/tools/lsp-tools.ts';
import { applyEdits, type EditOp } from '../agent/tools/file-tools.ts';
import { __setCurrentWorkspaceForTests } from '../workspace-registry.ts';
import { check, passedCount } from '../harness-kit.ts';

/**
 * Harness for the LSP-1 agent tools' guard paths that need NO live language
 * server (`npm run harness:lsp-request-methods`). It proves the safety posture:
 *
 *  - lsp_navigate with no workspace open → graceful error (not a throw).
 *  - lsp_navigate / lsp_symbols with a workspace but no ready server for the file
 *    type → a graceful "no ready LSP server" error (not a throw). With no servers
 *    spawned, getReadyClientsForFile returns [] for every file.
 *  - the rename APPLY path is the gated applyEdits — so a SECRET_FILE op and a
 *    denyGlobs op are BLOCKED through the exact function lsp_rename funnels into.
 *
 * A real definition/rename round-trip needs a spawned server and is covered by
 * the manual integration step in the ticket, not here.
 */

function makeCtx(ws: WorkspaceSummary | null, denyGlobs?: string[]): ToolContext {
  return {
    ws,
    signal: new AbortController().signal,
    ...(denyGlobs ? { denyGlobs } : {}),
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'lsp-req-'));
  writeFileSync(path.join(dir, 'app.ts'), 'export const x = 1;\n');
  writeFileSync(path.join(dir, '.env'), 'SECRET=shh\n');
  writeFileSync(path.join(dir, 'protected.ts'), 'export const y = 2;\n');
  const ws: WorkspaceSummary = { root: dir, name: 'LspTest', files: [], source: 'walk', truncated: false };
  __setCurrentWorkspaceForTests(ws);
  try {
    /* ── 1. navigate with no workspace → graceful error, not a throw ───────── */
    const noWs = await lspNavigate(
      { path: 'app.ts', line: 1, character: 14, kind: 'definition' },
      makeCtx(null),
    );
    check('navigate with no workspace returns isError (not a throw)', noWs.isError === true);
    check('navigate no-workspace message names the missing folder', /no folder is open/i.test(noWs.text));

    /* ── 2. no ready client → graceful "no ready LSP server" (not a throw) ─── */
    const noServerNav = await lspNavigate(
      { path: 'app.ts', line: 1, character: 14, kind: 'definition' },
      makeCtx(ws),
    );
    check('navigate with no ready server returns isError', noServerNav.isError === true);
    check('navigate no-server message says no ready LSP server', /no ready lsp server/i.test(noServerNav.text));

    const noServerRefs = await lspNavigate(
      { path: 'app.ts', line: 1, character: 14, kind: 'references' },
      makeCtx(ws),
    );
    check('navigate references with no ready server is also graceful', noServerRefs.isError === true);

    const noServerSymbols = await lspSymbols({ path: 'app.ts' }, makeCtx(ws));
    check('symbols with no ready server returns isError', noServerSymbols.isError === true);
    check('symbols no-server message says no ready LSP server', /no ready lsp server/i.test(noServerSymbols.text));

    const noServerRename = await lspRename(
      { path: 'app.ts', line: 1, character: 14, newName: 'z' },
      makeCtx(ws),
    );
    check('rename with no ready server returns isError (not a throw)', noServerRename.isError === true);
    check('rename no-server message says no ready LSP server', /no ready lsp server/i.test(noServerRename.text));

    /* ── 3. rename APPLY path == gated applyEdits → SECRET_FILE blocked ─────── */
    // lsp_rename converts the server's WorkspaceEdit into ops and calls
    // applyEdits(ops, ctx, 'lsp_rename'). Exercise THAT exact function with a
    // secret-file op to prove the rename's write path refuses credential files.
    const secretOps: EditOp[] = [{ path: '.env', oldString: 'shh', newString: 'z' }];
    const secretBlocked = await applyEdits(secretOps, makeCtx(ws), 'lsp_rename');
    check('lsp_rename apply path blocks a SECRET_FILE edit', secretBlocked.isError === true);
    check('SECRET_FILE block message mentions credentials/secret', /credentials|secret/i.test(secretBlocked.text));
    check('SECRET_FILE block did NOT apply (no edits recorded)', secretBlocked.edits === undefined);

    /* ── 4. rename APPLY path == gated applyEdits → denyGlobs blocked ───────── */
    const denyOps: EditOp[] = [{ path: 'protected.ts', oldString: 'const y = 2', newString: 'const z = 2' }];
    const denyBlocked = await applyEdits(denyOps, makeCtx(ws, ['protected.ts']), 'lsp_rename');
    check('lsp_rename apply path blocks a denyGlobs edit', denyBlocked.isError === true);
    check('denyGlobs block message mentions a denied path glob', /denied path glob/i.test(denyBlocked.text));
    check('denyGlobs block did NOT apply (no edits recorded)', denyBlocked.edits === undefined);

    console.log(`\nlsp-request-methods harness: ${passedCount()} assertions passed`);
  } finally {
    __setCurrentWorkspaceForTests(null);
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('lsp-request-methods harness FAILED:', err);
  process.exitCode = 1;
});
