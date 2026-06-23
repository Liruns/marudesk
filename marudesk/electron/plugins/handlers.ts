import { dialog, shell } from 'electron';
import { isValidPluginId } from '../../shared/plugin';
import { defineHandler } from '../ipc/define-handler';
import { bool, nonEmptyStr, obj } from '../ipc/validate';
import {
  getUserPluginsDir,
  installPluginFolder,
  listPluginCommands,
  listPluginLogs,
  listPluginStatuses,
  removePlugin,
  reloadPlugins,
  setPluginEnabled,
} from './index';
import { openUserPluginsFolder } from './open-folder';
import { getDialogLabels } from '../dialog-labels';

/**
 * IPC for Settings → Plugins and the composer's plugin slash commands
 * (docs/plugin-runtime-design.md §5, §7 P2). The analogue of
 * agent/mcp-handlers.ts's registerMcpHandlers: list statuses, reload, toggle
 * approval, install/remove user plugins, open the install folder, and expose a
 * one-way snapshot of contributed slash commands for the composer.
 */
export function registerPluginHandlers(): void {
  // Current per-plugin statuses (state + permissions + tool/command names). Cheap.
  defineHandler('plugins:list', () => listPluginStatuses());

  // Re-scan the user/project folders and reconcile (the "Reload" action — also how
  // a newly dropped-in plugin folder or a hand-edited manifest is picked up).
  defineHandler('plugins:reload', () => reloadPlugins());

  // Enable/disable one plugin, persist, and re-reconcile (spawn or tear down).
  defineHandler('plugins:set-enabled', ([payload]) => {
    const o = obj(payload);
    return setPluginEnabled(pluginId(o.id), bool(o.enabled, 'enabled'));
  });

  // Choose a folder that contains a plugin manifest, copy it into the user plugin
  // install directory, then rescan so the Settings list reflects it immediately.
  defineHandler('plugins:install-folder', async (args) => {
    if (args.length !== 0) throw new Error('install-folder takes no arguments');
    const result = await dialog.showOpenDialog({
      title: getDialogLabels().installPlugin,
      defaultPath: getUserPluginsDir(),
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return listPluginStatuses();
    return installPluginFolder(result.filePaths[0]);
  });

  // Snapshot of slash commands contributed by active plugins, for the composer.
  defineHandler('plugins:commands', () => listPluginCommands());

  // Recent (scrubbed) log lines + errors for one live plugin — the Settings card's
  // collapsible "Logs" view, so a misbehaving plugin is debuggable in-app.
  defineHandler('plugins:logs', ([payload]) => {
    const o = obj(payload);
    return [...listPluginLogs(pluginId(o.id))];
  });

  // Open the user plugin install folder so "drop a folder here, then Reload" is
  // an actual UI action instead of an instruction with no affordance.
  defineHandler('plugins:open-folder', async () => {
    return openUserPluginsFolder(getUserPluginsDir(), (dir) => shell.openPath(dir));
  });

  // Remove one installed user-scoped plugin, forget its saved grants, and rescan.
  defineHandler('plugins:remove', ([payload]) => {
    const o = obj(payload);
    return removePlugin(pluginId(o.id));
  });
}

function pluginId(value: unknown): string {
  const id = nonEmptyStr(value, 'id');
  if (!isValidPluginId(id)) throw new Error('id must be a valid plugin id');
  return id;
}
