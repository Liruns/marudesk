import type { McpServerConfig } from './mcp';

/**
 * Curated external-MCP presets (docs/context-mcp-design §9). A preset is a known,
 * popular server the user can add with one click instead of hand-writing the
 * `mcp-servers.json` entry. The headline one is **browser control**: like Codex
 * Desktop's "Chrome MCP", Google's `chrome-devtools-mcp` drives a real Chrome — full
 * cursor control, navigation, screenshots, DOM inspection — as a separate process,
 * so it works through marudesk's existing external-MCP connector without touching the
 * app's own CDP allowlist.
 *
 * Presets are added **untrusted + enabled**: tools are gated (approved per call) by
 * default since a browser controller is side-effecting; the user can mark the server
 * `trust: true` later by hand-editing the config. Shared so the renderer (Settings)
 * and the main process agree on the exact `id`/command without a round-trip.
 */

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
      'Drive a real Chrome browser (navigate, click, type, screenshot, inspect DOM/network) via Google’s chrome-devtools-mcp. Runs as a separate process.',
    docsUrl: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    config: {
      id: 'chrome-devtools',
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest'],
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
