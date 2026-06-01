/**
 * A minimal `electron` stand-in for the headless MCP harness (mcp-harness.ts).
 *
 * The external-MCP manager (mcp-external.ts) transitively imports the agent tool
 * layer, which value-imports a few electron members at module-load time (`shell`,
 * `app`, `dialog`). The harness never calls them — it injects a mock client and a
 * temp config — but the imports must resolve for the modules to load under `node
 * --experimental-strip-types`. This stub satisfies them with inert no-ops.
 *
 * Mapped onto the bare `electron` specifier by mcp-harness-register.mjs.
 */

import os from 'node:os';
import path from 'node:path';

const noop = () => {};

export const app = {
  getPath: () => path.join(os.tmpdir(), 'marudesk-mcp-harness'),
  getVersion: () => '0.0.0-harness',
};

export const shell = {
  openPath: async () => '',
  openExternal: async () => {},
  showItemInFolder: noop,
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
};

export const ipcMain = { handle: noop, on: noop };

export const clipboard = { writeText: noop, readText: () => '' };

export default { app, shell, dialog, ipcMain, clipboard };
