import { app } from 'electron';
import { isHttpMcpConfig, type McpServersFile } from '../../shared/mcp';
import {
  EMBEDDED_CHROMIUM_DEBUG_PORT,
  EMBEDDED_CHROMIUM_DEBUG_URL,
} from '../../shared/mcp-presets';
import { readMcpConfig, readMcpConfigSync } from './mcp-config';

/**
 * Embedded-browser CDP exposure (docs/context-mcp-design §10.4). The chrome-devtools
 * browser-control preset drives marudesk's OWN embedded tabs (the WebContentsView in
 * electron/browser/tabs.ts) by attaching over CDP to Chromium's remote-debugging
 * endpoint, instead of launching a separate local Chrome.
 *
 * That endpoint can only be enabled by a command-line switch set BEFORE app-ready —
 * there is no runtime API — so {@link maybeOpenEmbeddedDebugPort} runs at module
 * top-level in main.ts. We gate it on a configured + enabled server actually asking
 * to attach (its args reference our loopback `--browser-url`), so a packaged build
 * never exposes the embedded tabs over CDP unless the user opted in. Because the
 * switch is boot-only, adding the preset takes effect on the NEXT launch — the
 * Settings panel surfaces that via {@link embeddedBrowserDebugStatus}.
 */

/** Whether a config has an enabled (stdio) server wired to our embedded `--browser-url`. */
function configWantsEmbeddedDebug(file: McpServersFile): boolean {
  return file.servers.some(
    (s) =>
      s.enabled &&
      !isHttpMcpConfig(s) &&
      (s.args ?? []).some((a) => a.includes(EMBEDDED_CHROMIUM_DEBUG_URL)),
  );
}

/** Set once at boot in {@link maybeOpenEmbeddedDebugPort}; read by the Settings status. */
let portOpen = false;

/**
 * Open Chromium's remote-debugging endpoint on a fixed loopback port (127.0.0.1) when
 * the config asks for it. MUST be called before `app.whenReady()` (the switch has no
 * runtime API); reads the config synchronously since that path can't await.
 */
export function maybeOpenEmbeddedDebugPort(): void {
  if (!configWantsEmbeddedDebug(readMcpConfigSync())) return;
  app.commandLine.appendSwitch('remote-debugging-port', String(EMBEDDED_CHROMIUM_DEBUG_PORT));
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  portOpen = true;
}

/**
 * Status for Settings → MCP Servers. `required` is whether the LIVE config now wants
 * the embedded debug port; `portOpen` is whether we actually opened it this launch.
 * `required && !portOpen` means the user enabled browser control this session and must
 * restart for it to attach to the embedded browser (rather than failing to connect).
 */
export async function embeddedBrowserDebugStatus(): Promise<{
  portOpen: boolean;
  required: boolean;
}> {
  return { portOpen, required: configWantsEmbeddedDebug(await readMcpConfig()) };
}
