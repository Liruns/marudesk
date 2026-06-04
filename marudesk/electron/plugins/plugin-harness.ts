import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceSummary } from '../../shared/workspace';
import { pluginSlashCommand, resolveSlash } from '../../shared/slash-commands';
import type { ToolContext, ToolResult } from '../agent/tools';
import { buildPluginServer, PluginHost } from './host';
import { spawnViaChildProcess } from './transport';

/**
 * Headless harness for the plugin runtime (docs/plugin-runtime-design.md P1).
 * Runs with `node --experimental-strip-types` (see package.json `harness:plugins`).
 * Because the worker is Electron-free (design §R1), it is spawned here via
 * `child_process.fork` — the very same module production runs under
 * `utilityProcess` — so this exercises the real spawn → load → callTool → teardown
 * path without Electron. The child inherits `--experimental-strip-types`, so the
 * worker and its TypeScript deps run as-is.
 *
 * Asserts: (a) a plugin loads and reports its contributed tools + slash commands;
 * (b) a contributed tool, wrapped through buildPluginServer's namespaced McpTool,
 * routes to the worker and returns the handler's text; (c) the guarded `ctx.fs`
 * bridge reads a workspace file and REFUSES a path that escapes the root; (d) the
 * Module._load sandbox denies a plugin that requires `child_process`, so it fails
 * to load with a sandbox error; (e) teardown rejects cleanly.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = path.join(__dirname, 'worker.ts');
const HELLO_DIR = path.resolve(__dirname, '../../examples/plugins/hello-world');
const EVIL_DIR = path.join(__dirname, '__fixtures__/evil');

let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

/** A minimal ToolContext pointing at a throwaway workspace root. */
function toolContext(root: string): ToolContext {
  const ws: WorkspaceSummary = { root, name: 'tmp', files: [], source: 'walk', truncated: false };
  return { ws, signal: new AbortController().signal };
}

async function main(): Promise<void> {
  // ── (a)(b)(c): the well-behaved hello-world plugin ───────────────────────────
  const helloGrants = ['tools', 'commands', 'fs:read'] as const;
  const { channel } = spawnViaChildProcess({
    workerEntry: WORKER_ENTRY,
    pluginDir: HELLO_DIR,
    granted: [...helloGrants],
  });
  const host = new PluginHost(channel, 'hello-world');
  const contributions = await host.load(HELLO_DIR, 'index.js', [...helloGrants]);

  check('plugin contributes the greet + read_file tools', contributions.tools.length === 2);
  check(
    'tool names are reported',
    contributions.tools.some((t) => t.name === 'greet') &&
      contributions.tools.some((t) => t.name === 'read_file'),
  );
  check('plugin contributes the hello slash command', contributions.commands[0]?.name === 'hello');
  check('slash command carries a $ARGUMENTS template', contributions.commands[0]?.template.includes('$ARGUMENTS'));

  const server = buildPluginServer('hello-world', host, contributions);
  const greet = server.tools.find((t) => t.name === 'plugin:hello-world__greet');
  check('greet tool is namespaced under plugin:<id>__', !!greet);
  check('greet tool is grouped "plugin" and gated', greet?.group === 'plugin' && greet?.gated === true);

  // Make a temp workspace with a file the fs:read tool can reach.
  const wsRoot = mkdtempSync(path.join(os.tmpdir(), 'marudesk-plugin-'));
  writeFileSync(path.join(wsRoot, 'NOTES.md'), 'hello from the workspace');
  const ctx = toolContext(wsRoot);

  const greetRes: ToolResult = await greet!.exec({ name: 'Ada' }, ctx);
  check('greet returns the handler text', greetRes.text.includes('Hello, Ada!') && !greetRes.isError);

  const readTool = server.tools.find((t) => t.name === 'plugin:hello-world__read_file')!;
  const readRes = await readTool.exec({ path: 'NOTES.md' }, ctx);
  check('fs:read tool reads a workspace file', readRes.text.includes('hello from the workspace') && !readRes.isError);

  const escapeRes = await readTool.exec({ path: '../../../etc/passwd' }, ctx);
  check('fs:read refuses a path that escapes the workspace', escapeRes.isError === true);

  // fs without a workspace: the same tool with a null-ws context must be refused.
  const noWsRes = await readTool.exec({ path: 'NOTES.md' }, { ws: null, signal: new AbortController().signal });
  check('fs:read refuses when no workspace is open', noWsRes.isError === true);

  // ── slash: the plugin's command becomes a namespaced prompt command ──────────
  const slash = pluginSlashCommand('hello-world', contributions.commands[0]);
  check('plugin slash command is namespaced plugin id:name', slash.name === 'hello-world:hello');
  check('plugin slash expand substitutes $ARGUMENTS', slash.expand('Ada') === 'Please greet Ada warmly and concisely.');
  const resolved = resolveSlash('/hello-world:hello Ada', [slash]);
  check('resolveSlash matches the namespaced plugin command + arg', resolved?.command.name === 'hello-world:hello' && resolved?.arg === 'Ada');

  host.dispose();

  // ── (d): the hostile plugin is denied at the sandbox ─────────────────────────
  const evil = spawnViaChildProcess({ workerEntry: WORKER_ENTRY, pluginDir: EVIL_DIR, granted: ['tools'] });
  const evilHost = new PluginHost(evil.channel, 'evil');
  let evilError = '';
  try {
    await evilHost.load(EVIL_DIR, 'index.js', ['tools']);
  } catch (err) {
    evilError = (err as Error).message;
  }
  check('evil plugin fails to load (sandbox denies child_process)', /not permitted|sandbox/.test(evilError));
  evilHost.dispose();

  console.log(`\n# plugin harness: ${passed} checks passed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
