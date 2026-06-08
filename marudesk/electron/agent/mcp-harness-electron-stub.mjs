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

export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text, 'utf8'),
  decryptString: (buffer) => Buffer.from(buffer).toString('utf8'),
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

// Browser-layer value-imports reached transitively by the worktree/thread
// harnesses (context-menu.ts → `Menu`, favicon.ts → `net`, etc.). The harness
// never drives the UI/network; these just have to resolve so the modules load.
export const Menu = {
  buildFromTemplate: () => ({ popup: noop, closePopup: noop }),
  setApplicationMenu: noop,
};

export const net = { request: () => ({ on: noop, end: noop, abort: noop }) };

export const protocol = { handle: noop, registerSchemesAsPrivileged: noop };

export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) };

export const session = { defaultSession: { webRequest: { onBeforeRequest: noop } } };

export const contextBridge = { exposeInMainWorld: noop };

export const ipcRenderer = { invoke: async () => undefined, on: noop, send: noop };

export const utilityProcess = { fork: () => ({ on: noop, postMessage: noop, kill: noop }) };

class StubBrowserWindow {}
export const BrowserWindow = StubBrowserWindow;

class StubWebContentsView {}
export const WebContentsView = StubWebContentsView;

class StubWebContents {}
export const WebContents = StubWebContents;

export default {
  app,
  safeStorage,
  shell,
  dialog,
  ipcMain,
  clipboard,
  Menu,
  net,
  protocol,
  screen,
  session,
  contextBridge,
  ipcRenderer,
  utilityProcess,
  BrowserWindow,
  WebContentsView,
  WebContents,
};
