import type { McpServerConfig } from './mcp';

/**
 * Curated external-MCP presets (docs/context-mcp-design §9). A preset is a known,
 * popular server the user can add with one click instead of hand-writing the
 * `mcp-servers.json` entry. The headline one is **browser control**: like Codex
 * Desktop's "Chrome MCP", Google's `chrome-devtools-mcp` gives the agent full
 * navigation, clicking, typing, screenshots, and DOM/network inspection. We point it
 * at marudesk's OWN embedded browser tabs (the WebContentsView in electron/browser/
 * tabs.ts) by passing `--browser-url=<loopback>` ({@link EMBEDDED_CHROMIUM_DEBUG_URL}):
 * it attaches over CDP to the remote-debugging port marudesk opens (electron/main.ts,
 * gated on this preset being enabled) instead of launching a separate local Chrome.
 * Because that switch can only be set before app-ready, adding the preset takes effect
 * on the next launch.
 *
 * Presets are added **untrusted + enabled**: tools are gated (approved per call) by
 * default since a browser controller is side-effecting; the user can mark the server
 * `trust: true` later by hand-editing the config. Shared so the renderer (Settings)
 * and the main process agree on the exact `id`/command without a round-trip.
 */

/**
 * Loopback port marudesk opens Chromium's remote-debugging endpoint on. The switch
 * is set in electron/main.ts BEFORE app-ready (it has no runtime API) and ONLY when
 * the browser-control preset below is configured + enabled, so a packaged build never
 * exposes the embedded tabs over CDP unless the user opted in. Bound to 127.0.0.1.
 */
export const EMBEDDED_CHROMIUM_DEBUG_PORT = 9333;
/** The full loopback URL chrome-devtools-mcp connects to via `--browser-url`. */
export const EMBEDDED_CHROMIUM_DEBUG_URL = `http://127.0.0.1:${EMBEDDED_CHROMIUM_DEBUG_PORT}`;

export type McpServerPreset = {
  /** The config id that will be written (also the tool namespace `<id>__<tool>`). */
  readonly id: string;
  /** Short display name for the Settings "Add" control. */
  readonly label: string;
  /** One-line description of what the server gives the agent. */
  readonly description: string;
  /** Where to read more (the server's home page). */
  readonly docsUrl: string;
  /** The exact config entry written to `mcp-servers.json`. */
  readonly config: McpServerConfig;
};

export const MCP_PRESETS: readonly McpServerPreset[] = [
  {
    id: 'chrome-devtools',
    label: 'Chrome DevTools — browser control',
    description:
      'Drive marudesk’s embedded browser tabs (navigate, click, type, screenshot, inspect DOM/network) via Google’s chrome-devtools-mcp, attached over CDP. Takes effect after the next app launch.',
    docsUrl: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    config: {
      id: 'chrome-devtools',
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest', `--browser-url=${EMBEDDED_CHROMIUM_DEBUG_URL}`],
      enabled: true,
    },
  },
  {
    id: 'playwright',
    label: 'Playwright — browser automation',
    description:
      'Cross-browser automation (Chromium/Firefox/WebKit) via Microsoft’s Playwright MCP — accessibility-tree driven actions and assertions.',
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
    config: {
      id: 'playwright',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
      enabled: true,
    },
  },
];

/** Look up a preset by id (the value the renderer sends to `mcp:add-preset`). */
export function findMcpPreset(id: string): McpServerPreset | undefined {
  return MCP_PRESETS.find((p) => p.id === id);
}
