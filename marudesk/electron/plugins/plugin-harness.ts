import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, passedCount } from '../harness-kit';
import type { WorkspaceSummary } from '../../shared/workspace';
import { isSafePanelPath } from '../../shared/plugin';
import { pluginSlashCommand, resolveSlash } from '../../shared/slash-commands';
import type { ToolContext, ToolResult } from '../agent/tools';
import { satisfiesEngine } from './engine-compat';
import { buildPluginServer, PluginHost } from './host';
import { installUserPluginFolder, removeUserPluginFolder } from './lifecycle';
import { guardedExec, guardedFetch } from './permissions';
import type { PluginStatusUpdate } from './host';
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
const CMDSTATUS_DIR = path.join(__dirname, '__fixtures__/cmdstatus');
const PROTOCOL_SRC = path.join(__dirname, 'protocol.ts');

/** A minimal ToolContext pointing at a throwaway workspace root. */
function toolContext(root: string): ToolContext {
  const ws: WorkspaceSummary = { root, name: 'tmp', files: [], source: 'walk', truncated: false };
  return { ws, signal: new AbortController().signal };
}

/**
 * Pull the `PANEL_CSP` directive list out of protocol.ts source and index it by
 * directive name (plus a `__raw` field of the whole policy). protocol.ts can't be
 * imported here (it's Electron-coupled), so the source is the served-CSP contract.
 */
function parsePanelCsp(src: string): Record<string, string> {
  const block = /const PANEL_CSP = \[([\s\S]*?)\]\.join/.exec(src)?.[1];
  if (!block) throw new Error('PANEL_CSP array not found in protocol.ts');
  const directives = [...block.matchAll(/(["'])((?:(?!\1).)*)\1/g)].map((m) => m[2].trim());
  const map: Record<string, string> = { __raw: directives.join('; ') };
  for (const directive of directives) {
    const space = directive.indexOf(' ');
    if (space === -1) map[directive] = '';
    else map[directive.slice(0, space)] = directive.slice(space + 1).trim();
  }
  return map;
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

  // ── ctx.exec + ctx.setStatus + onSession lifecycle (host-mediated) ───────────
  {
    const grants = ['tools', 'cmd'] as const;
    const statuses: PluginStatusUpdate[] = [];
    const cs = spawnViaChildProcess({ workerEntry: WORKER_ENTRY, pluginDir: CMDSTATUS_DIR, granted: [...grants] });
    const csHost = new PluginHost(cs.channel, 'cmdstatus', (u) => statuses.push(u));
    const csContrib = await csHost.load(CMDSTATUS_DIR, 'index.js', [...grants]);
    const csServer = buildPluginServer('cmdstatus', csHost, csContrib);
    const runTool = csServer.tools.find((t) => t.name === 'plugin:cmdstatus__run_and_count')!;

    // Lifecycle: a session-start before the call, so the tool sees a non-zero count.
    csHost.notifySession('session-start', 'sess-A');
    const csCtx = toolContext(wsRoot);
    const ran = await runTool.exec(
      { command: 'node -e "process.stdout.write(\'EXEC-OK\')"' },
      csCtx,
    );
    check('ctx.exec routes a CLI through the host and returns its output', !ran.isError && /EXEC-OK/.test(ran.text));
    const parsed = JSON.parse(ran.text) as { exitCode: number | null; output: string; sessions: number };
    check('ctx.exec reports exitCode 0 for a successful command', parsed.exitCode === 0);
    check('onSessionStart was delivered (lifecycle log has 1 session)', parsed.sessions === 1);
    check('ctx.setStatus pushes a keyed status update to the host', statuses.some((s) => s.statusKey === 'progress' && /running/.test(s.text)));
    check('ctx.setStatus with empty text clears the key', statuses.some((s) => s.statusKey === 'progress' && s.text === ''));

    // Lifecycle: session-end resets the plugin's per-conversation state.
    csHost.notifySession('session-end', 'sess-A');
    csHost.notifySession('session-start', 'sess-B');
    const ranAgain = await runTool.exec({ command: 'node -e "process.stdout.write(\'OK\')"' }, csCtx);
    const parsedAgain = JSON.parse(ranAgain.text) as { sessions: number };
    check('onSessionEnd reset per-conversation state (count back to 1, not 2)', parsedAgain.sessions === 1);
    csHost.dispose();
  }

  // ── ctx.exec is refused without the `cmd` grant (host re-checks) ──────────────
  {
    const noCmd = spawnViaChildProcess({ workerEntry: WORKER_ENTRY, pluginDir: CMDSTATUS_DIR, granted: ['tools'] });
    const noCmdHost = new PluginHost(noCmd.channel, 'cmdstatus');
    const noCmdContrib = await noCmdHost.load(CMDSTATUS_DIR, 'index.js', ['tools']);
    const noCmdTool = buildPluginServer('cmdstatus', noCmdHost, noCmdContrib).tools.find(
      (t) => t.name === 'plugin:cmdstatus__run_and_count',
    )!;
    const denied = await noCmdTool.exec({ command: 'node -e "0"' }, toolContext(wsRoot));
    check('ctx.exec is refused when the plugin lacks the cmd grant', denied.isError === true && /cmd/.test(denied.text));
    noCmdHost.dispose();
  }

  // ── guardedExec directly: bounded, workspace-rooted, no-workspace refused ─────
  {
    const ec = toolContext(wsRoot);
    const ok = await guardedExec(ec, 'node -e "process.stdout.write(\'direct\')"');
    check('guardedExec runs in the workspace and captures output', ok.exitCode === 0 && /direct/.test(ok.output) && ok.timedOut === false);
    let noWsExecErr = '';
    try {
      await guardedExec({ ws: null, signal: new AbortController().signal }, 'node -e "0"');
    } catch (err) {
      noWsExecErr = (err as Error).message;
    }
    check('guardedExec refuses when no workspace is open', /no workspace/.test(noWsExecErr));
  }

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

  // ── v2: panel CSP contract (electron/plugins/protocol.ts PANEL_CSP) ───────────
  // protocol.ts is Electron-coupled (imports `electron` via ./index), so it can't
  // be imported into this Electron-free harness; assert the served CSP directives
  // from its source of truth instead. This locks the security-critical shape so a
  // regression that grants network egress or widens script/style origins is caught.
  const panelCsp = parsePanelCsp(readFileSync(PROTOCOL_SRC, 'utf8'));
  check('panel CSP starts from a deny-all default', panelCsp['default-src'] === "'none'");
  check('panel CSP keeps panels off the network (no exfiltration)', panelCsp['connect-src'] === "'none'");
  check('panel CSP forbids base-uri + form-action escapes', panelCsp['base-uri'] === "'none'" && panelCsp['form-action'] === "'none'");
  // Inline script/style stay (static, build-less, opaque-origin panels; see the
  // rationale comment in protocol.ts) — but ONLY from the panel's own plugin: origin.
  check(
    'panel CSP scopes scripts to plugin: only — never a wildcard or remote origin',
    panelCsp['script-src'] === "'unsafe-inline' plugin:",
  );
  check(
    'panel CSP scopes styles to plugin: only — never a wildcard or remote origin',
    panelCsp['style-src'] === "'unsafe-inline' plugin:",
  );
  check(
    'panel CSP never broadens script-src to * / https: / http: / data:',
    !/script-src[^;]*(\*|https:|http:|data:)/.test(panelCsp.__raw),
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

  console.log(`\n# plugin harness: ${passedCount()} checks passed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
