import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceSummary } from '../../shared/workspace';
import { isSafePanelPath } from '../../shared/plugin';
import { pluginSlashCommand, resolveSlash } from '../../shared/slash-commands';
import type { ToolContext, ToolResult } from '../agent/tools';
import { satisfiesEngine } from './engine-compat';
import { buildPluginServer, PluginHost } from './host';
import { installUserPluginFolder, removeUserPluginFolder } from './lifecycle';
import { guardedFetch } from './permissions';
import { readPluginManifest } from './manifest';
import { openUserPluginsFolder } from './open-folder';
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
  const helloGrants = ['tools', 'commands', 'fs:read', 'fs:write'] as const;
  const { channel } = spawnViaChildProcess({
    workerEntry: WORKER_ENTRY,
    pluginDir: HELLO_DIR,
    granted: [...helloGrants],
  });
  const host = new PluginHost(channel, 'hello-world');
  const contributions = await host.load(HELLO_DIR, 'index.js', [...helloGrants]);

  check('plugin contributes the greet + read_file + write_note tools', contributions.tools.length === 3);
  check(
    'tool names are reported',
    ['greet', 'read_file', 'write_note'].every((n) => contributions.tools.some((t) => t.name === n)),
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

  // ── fs:write → AppliedChange surfaced as ToolResult.edits (P3) ────────────────
  const writeTool = server.tools.find((t) => t.name === 'plugin:hello-world__write_note')!;
  const createRes = await writeTool.exec({ path: 'OUT.md', content: 'first' }, ctx);
  check('fs:write creates the file on disk', readFileSync(path.join(wsRoot, 'OUT.md'), 'utf8') === 'first');
  check(
    'fs:write surfaces an AppliedChange (create) in ToolResult.edits',
    !createRes.isError &&
      createRes.edits?.length === 1 &&
      createRes.edits[0].kind === 'create' &&
      createRes.edits[0].before === null &&
      createRes.edits[0].after === 'first',
  );
  const overwriteRes = await writeTool.exec({ path: 'OUT.md', content: 'second' }, ctx);
  check(
    'fs:write overwrite yields an edit change with before/after',
    overwriteRes.edits?.[0].kind === 'edit' &&
      overwriteRes.edits[0].before === 'first' &&
      overwriteRes.edits[0].after === 'second',
  );
  const denyCtx: ToolContext = { ...ctx, denyGlobs: ['*.md'] };
  const deniedWrite = await writeTool.exec({ path: 'OUT.md', content: 'nope' }, denyCtx);
  check('fs:write honors the never-edit denyGlobs', deniedWrite.isError === true);

  // ── net guards (direct — no live network) ────────────────────────────────────
  let allowlistErr = '';
  try {
    await guardedFetch('https://evil.example/', ['api.github.com']);
  } catch (err) {
    allowlistErr = (err as Error).message;
  }
  check('net refuses a host not in the allowlist', /allowlist/.test(allowlistErr));
  let privateErr = '';
  try {
    await guardedFetch('http://localhost/', ['localhost']);
  } catch (err) {
    privateErr = (err as Error).message;
  }
  check('net refuses an allowlisted host that resolves to a private address', /non-public/.test(privateErr));

  // ── grant enforcement: the same plugin without fs:write can't write ──────────
  // Grant everything except fs:write so activate (which registers tools + a slash
  // command + uses nothing at load) still succeeds, then prove the write is denied.
  const roGrants = ['tools', 'commands', 'fs:read'] as const;
  const ro = spawnViaChildProcess({ workerEntry: WORKER_ENTRY, pluginDir: HELLO_DIR, granted: [...roGrants] });
  const roHost = new PluginHost(ro.channel, 'hello-world');
  const roContrib = await roHost.load(HELLO_DIR, 'index.js', [...roGrants]);
  const roWrite = buildPluginServer('hello-world', roHost, roContrib).tools.find(
    (t) => t.name === 'plugin:hello-world__write_note',
  )!;
  const ungranted = await roWrite.exec({ path: 'OUT.md', content: 'x' }, ctx);
  check('fs:write is refused when the plugin lacks the fs:write grant', ungranted.isError === true);
  roHost.dispose();

  // ── slash: the plugin's command becomes a namespaced prompt command ──────────
  const slash = pluginSlashCommand('hello-world', contributions.commands[0]);
  check('plugin slash command is namespaced plugin id:name', slash.name === 'hello-world:hello');
  check('plugin slash expand substitutes $ARGUMENTS', slash.expand('Ada') === 'Please greet Ada warmly and concisely.');
  const resolved = resolveSlash('/hello-world:hello Ada', [slash]);
  check('resolveSlash matches the namespaced plugin command + arg', resolved?.command.name === 'hello-world:hello' && resolved?.arg === 'Ada');

  host.dispose();

  // ── (d): raw network modules are denied even WITH the net grant ──────────────
  const evil = spawnViaChildProcess({ workerEntry: WORKER_ENTRY, pluginDir: EVIL_DIR, granted: ['net'] });
  const evilHost = new PluginHost(evil.channel, 'evil');
  let evilError = '';
  try {
    await evilHost.load(EVIL_DIR, 'index.js', ['net']);
  } catch (err) {
    evilError = (err as Error).message;
  }
  check('sandbox denies raw network modules even with the net grant', /not permitted|sandbox/.test(evilError));
  evilHost.dispose();

  // ── v2: panel path-scoping gate (the plugin:// resolver's first check) ───────
  check('panel path allows a plain relative file', isSafePanelPath('panel.html') && isSafePanelPath('assets/app.js'));
  check(
    'panel path rejects traversal / absolute / scheme / backslash / nul',
    !isSafePanelPath('../secret') &&
      !isSafePanelPath('a/../../b') &&
      !isSafePanelPath('/etc/passwd') &&
      !isSafePanelPath('..') &&
      !isSafePanelPath('c:\\win') &&
      !isSafePanelPath('a\\b') &&
      !isSafePanelPath('http://x') &&
      !isSafePanelPath('a\0b') &&
      !isSafePanelPath(''),
  );

  // ── Settings → Plugins: "Open plugins folder" handler core ───────────────
  const installDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'marudesk-plugins-open-')), 'plugins');
  const opened: string[] = [];
  const openedResult = await openUserPluginsFolder(installDir, async (dir) => {
    opened.push(dir);
    return '';
  });
  check('open plugins folder creates the install directory', existsSync(installDir));
  check('open plugins folder calls shell.openPath with that directory', opened[0] === installDir);
  check('open plugins folder returns the opened path', openedResult.path === installDir);
  let openFolderError = '';
  try {
    await openUserPluginsFolder(installDir, async () => 'open failed');
  } catch (err) {
    openFolderError = (err as Error).message;
  }
  check('open plugins folder surfaces shell.openPath failures', openFolderError === 'open failed');

  // ── Settings → Plugins: install/remove helpers ────────────────────────────
  const installRoot = mkdtempSync(path.join(os.tmpdir(), 'marudesk-plugins-install-'));
  const installId = await installUserPluginFolder(installRoot, HELLO_DIR);
  check('install plugin copies the selected folder into the user plugin dir', installId === 'hello-world');
  check(
    'install plugin copies the manifest into the destination folder',
    existsSync(path.join(installRoot, 'hello-world', 'manifest.json')),
  );
  const installedManifest = await readPluginManifest(path.join(installRoot, 'hello-world'));
  check('install plugin keeps the copied folder valid', installedManifest?.id === 'hello-world');
  let duplicateError = '';
  try {
    await installUserPluginFolder(installRoot, HELLO_DIR);
  } catch (err) {
    duplicateError = (err as Error).message;
  }
  check('install plugin refuses to overwrite an existing install from another source', /already installed/.test(duplicateError));
  let installedFolderError = '';
  try {
    await installUserPluginFolder(installRoot, path.join(installRoot, 'hello-world'));
  } catch (err) {
    installedFolderError = (err as Error).message;
  }
  check('install plugin refuses to reinstall an already-installed folder', /already installed/.test(installedFolderError));
  const invalidRoot = mkdtempSync(path.join(os.tmpdir(), 'marudesk-plugins-invalid-'));
  const invalidSource = path.join(invalidRoot, 'not-a-plugin');
  await fs.mkdir(invalidSource, { recursive: true });
  let invalidInstallError = '';
  try {
    await installUserPluginFolder(installRoot, invalidSource);
  } catch (err) {
    invalidInstallError = (err as Error).message;
  }
  check('install plugin rejects a folder without a valid manifest', /not a valid plugin/.test(invalidInstallError));
  await removeUserPluginFolder(installRoot, 'hello-world');
  check('remove plugin deletes the installed user plugin folder', !existsSync(path.join(installRoot, 'hello-world')));

  // Engine compat (audit H9): the range forms a manifest realistically uses.
  check('engine: empty/any range allows', satisfiesEngine('0.1.1', undefined) && satisfiesEngine('0.1.1', '*'));
  check('engine: caret 0.x pins the minor', satisfiesEngine('0.1.5', '^0.1.0') && !satisfiesEngine('0.2.0', '^0.1.0'));
  check('engine: caret >=1 pins the major', satisfiesEngine('1.4.0', '^1.2.0') && !satisfiesEngine('2.0.0', '^1.2.0'));
  check('engine: >= and exact', satisfiesEngine('0.2.0', '>=0.1.0') && !satisfiesEngine('0.1.0', '0.2.0'));
  check('engine: unparseable range does not block', satisfiesEngine('0.1.1', 'next'));

  console.log(`\n# plugin harness: ${passed} checks passed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
