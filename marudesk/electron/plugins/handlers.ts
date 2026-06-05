import { shell } from 'electron';
import { defineHandler } from '../ipc/define-handler';
import { bool, nonEmptyStr, obj } from '../ipc/validate';
import {
  getUserPluginsDir,
  listPluginCommands,
  listPluginStatuses,
  reloadPlugins,
  setPluginEnabled,
} from './index';
import { openUserPluginsFolder } from './open-folder';

/**
 * IPC for Settings → Plugins and the composer's plugin slash commands
 * (docs/plugin-runtime-design.md §5, §7 P2). The analogue of
 * agent/mcp-handlers.ts's registerMcpHandlers: list statuses, reload (re-scan +
 * reconcile), toggle enable (which also approves the declared permissions — the
 * card shows them), and a one-way snapshot of contributed slash commands for the
 * composer to merge into its `/` menu.
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
    return setPluginEnabled(nonEmptyStr(o.id, 'id'), bool(o.enabled, 'enabled'));
  });

  // Snapshot of slash commands contributed by active plugins, for the composer.
  defineHandler('plugins:commands', () => listPluginCommands());

  // Open the user plugin install folder so "drop a folder here, then Reload" is
  // an actual UI action instead of an instruction with no affordance.
  defineHandler('plugins:open-folder', async () => {
    return openUserPluginsFolder(getUserPluginsDir(), (dir) => shell.openPath(dir));
  });
}
