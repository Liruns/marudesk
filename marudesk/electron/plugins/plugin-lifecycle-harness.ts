import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { InvokeChannel } from '../../shared/ipc';
import type { PluginStatus } from '../../shared/plugin';
import { readPluginsConfig } from './config';
import { initPlugins, shutdownPlugins } from './index';
import { registerPluginHandlers } from './handlers';
import { spawnViaChildProcess, type SpawnWorker } from './transport';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = path.join(__dirname, 'worker.ts');
const HELLO_DIR = path.resolve(__dirname, '../../examples/plugins/hello-world');

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown;
type AppPathName = Parameters<typeof app.getPath>[0];

let passed = 0;

function check(label: string, condition: boolean): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

async function expectReject(label: string, action: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let message = '';
  try {
    await action();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  check(label, pattern.test(message));
}

function statusById(statuses: readonly PluginStatus[], id: string): PluginStatus | undefined {
  return statuses.find((status) => status.id === id);
}

async function copyDir(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true });
}

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'marudesk-plugin-lifecycle-'));
  const userData = path.join(tempRoot, 'user-data');
  const userPlugins = path.join(userData, 'plugins');
  const workspaceRoot = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspaceRoot, { recursive: true });

  const handlers = new Map<string, Handler>();
  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalShowOpenDialog = dialog.showOpenDialog.bind(dialog);
  const originalGetPath = app.getPath.bind(app);
  const originalGetVersion = app.getVersion.bind(app);

  ipcMain.handle = ((channel: string, handler: Handler) => {
    handlers.set(channel, handler);
  }) as typeof ipcMain.handle;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [HELLO_DIR] });
  app.getPath = ((name: AppPathName) => (name === 'userData' ? userData : originalGetPath(name))) as typeof app.getPath;
  app.getVersion = (() => '1.0.0') as typeof app.getVersion;

  const spawnWithWorkerEntry: SpawnWorker = (opts) =>
    spawnViaChildProcess({ ...opts, workerEntry: WORKER_ENTRY });

  try {
    await initPlugins(() => workspaceRoot, { userDir: userPlugins, spawn: spawnWithWorkerEntry });
    registerPluginHandlers();

    const invoke = async (channel: InvokeChannel, ...args: unknown[]): Promise<unknown> => {
      const handler = handlers.get(channel);
      assert.ok(handler, `missing handler ${channel}`);
      return handler({} as IpcMainInvokeEvent, ...args);
    };

    // C001: valid install -> disabled user plugin -> enable approval -> remove.
    const installed = (await invoke('plugins:install-folder')) as PluginStatus[];
    const installedStatus = statusById(installed, 'hello-world');
    check('valid folder install lists hello-world', installedStatus?.id === 'hello-world');
    check('installed plugin is user-scoped', installedStatus?.scope === 'user');
    check('installed plugin starts disabled', installedStatus?.state === 'disabled');
    check('install copies the plugin folder', existsSync(path.join(userPlugins, 'hello-world', 'manifest.json')));
    check('install does not create approval config', (await readPluginsConfig()).plugins.length === 0);

    const enabled = (await invoke('plugins:set-enabled', { id: 'hello-world', enabled: true })) as PluginStatus[];
    const enabledStatus = statusById(enabled, 'hello-world');
    const enabledConfig = (await readPluginsConfig()).plugins.find((entry) => entry.id === 'hello-world');
    check('set-enabled activates the imported plugin', enabledStatus?.state === 'active');
    check('set-enabled persists declared approval grants', enabledConfig?.granted.length === 5);
    check('active status exposes contributed tools', (enabledStatus?.toolNames.length ?? 0) > 0);

    const removed = (await invoke('plugins:remove', { id: 'hello-world' })) as PluginStatus[];
    check('remove deletes user plugin folder', !existsSync(path.join(userPlugins, 'hello-world')));
    check('remove drops the status row', !statusById(removed, 'hello-world'));
    check('remove clears only that plugin config row', !(await readPluginsConfig()).plugins.some((p) => p.id === 'hello-world'));

    // C002: malformed, invalid, duplicate, unknown, and project-scoped removal.
    await expectReject(
      'malformed remove payload rejects',
      () => invoke('plugins:remove', { id: '' }),
      /id must not be empty/,
    );
    await expectReject(
      'malformed install payload rejects',
      () => invoke('plugins:install-folder', { sourceDir: HELLO_DIR }),
      /takes no arguments/,
    );

    const invalidSource = path.join(tempRoot, 'bad-plugin');
    await fs.mkdir(invalidSource, { recursive: true });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [invalidSource] });
    await expectReject(
      'invalid plugin folder install rejects',
      () => invoke('plugins:install-folder'),
      /not a valid plugin/,
    );
    check('invalid plugin folder is not copied', !existsSync(path.join(userPlugins, 'bad-plugin')));

    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [HELLO_DIR] });
    await invoke('plugins:install-folder');
    await fs.writeFile(path.join(userPlugins, 'hello-world', 'marker.txt'), 'kept');
    await expectReject('duplicate user install rejects', () => invoke('plugins:install-folder'), /already installed/);
    check(
      'duplicate install does not overwrite the existing folder',
      (await fs.readFile(path.join(userPlugins, 'hello-world', 'marker.txt'), 'utf8')) === 'kept',
    );

    const beforeUnknown = ((await invoke('plugins:list')) as PluginStatus[]).length;
    const afterUnknown = ((await invoke('plugins:remove', { id: 'missing-plugin' })) as PluginStatus[]).length;
    check('unknown remove is a no-op', beforeUnknown === afterUnknown);

    const projectPlugin = path.join(workspaceRoot, '.marudesk', 'plugins', 'hello-world');
    await copyDir(HELLO_DIR, projectPlugin);
    const projectStatuses = (await invoke('plugins:reload')) as PluginStatus[];
    check('project plugin is discovered as project-scoped', statusById(projectStatuses, 'hello-world')?.scope === 'project');
    check('project-shadowed user install is flagged for cleanup', statusById(projectStatuses, 'hello-world')?.hasUserInstall === true);
    const shadowCleanup = (await invoke('plugins:remove', { id: 'hello-world' })) as PluginStatus[];
    check('remove cleans up a project-shadowed user plugin folder', !existsSync(path.join(userPlugins, 'hello-world')));
    check('project-shadow cleanup leaves the project plugin visible', statusById(shadowCleanup, 'hello-world')?.scope === 'project');
    check('project-shadow cleanup leaves the project plugin folder intact', existsSync(path.join(projectPlugin, 'manifest.json')));
    await expectReject(
      'project-scoped plugin cannot be removed through user lifecycle IPC',
      () => invoke('plugins:remove', { id: 'hello-world' }),
      /only user plugins can be removed/,
    );
    check('project plugin folder remains after rejected remove', existsSync(path.join(projectPlugin, 'manifest.json')));
    await expectReject(
      'install rejects a user plugin id that is already provided by the project scope',
      () => invoke('plugins:install-folder'),
      /already exists as a project plugin/,
    );
    check(
      'project-shadowed install does not copy a hidden user plugin folder',
      !existsSync(path.join(userPlugins, 'hello-world')),
    );

    console.log(`\n# plugin lifecycle harness: ${passed} checks passed`);
  } finally {
    shutdownPlugins();
    ipcMain.handle = originalHandle;
    dialog.showOpenDialog = originalShowOpenDialog;
    app.getPath = originalGetPath;
    app.getVersion = originalGetVersion;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
