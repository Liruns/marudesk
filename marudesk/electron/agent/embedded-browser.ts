import { app } from 'electron';
import { isHttpMcpConfig, type McpServersFile } from '../../shared/mcp';
import {
  EMBEDDED_CHROMIUM_DEBUG_PORT,
  EMBEDDED_CHROMIUM_DEBUG_URL,
} from '../../shared/mcp-presets';
import { getSettings, readSettingsSync } from '../settings';
import { readMcpConfig, readMcpConfigSync } from './mcp-config';

/**
 * Embedded-browser CDP exposure (docs/context-mcp-design §10.4). The chrome-devtools
 * browser-control preset drives marudesk's OWN embedded tabs (the WebContentsView in
 * electron/browser/tabs.ts) by attaching over CDP to Chromium's remote-debugging
 * endpoint, instead of launching a separate local Chrome.
 *
 * That endpoint can only be enabled by a command-line switch set BEFORE app-ready —
 * there is no runtime API — so {@link maybeOpenEmbeddedDebugPort} runs at module
 * top-level in main.ts. We gate it on TWO independent conditions (see
 * {@link shouldOpenDebugPort}):
 *   1. a configured + enabled server actually asking to attach (its args reference
 *      our loopback `--browser-url`), AND
 *   2. an explicit, default-OFF user opt-in (`browser.allowDebugPort`).
 *
 * SECURITY: the CDP port is bound to 127.0.0.1 but is UNAUTHENTICATED — once open,
 * ANY local process can fully drive every embedded WebContentsView. The MCP arg
 * condition alone is NOT sufficient: a stray browser-control preset must never silently
 * expose the tabs. The user has to knowingly turn the port on, and a title-bar badge is
 * shown whenever it is actually open ({@link embeddedBrowserDebugStatus}.portOpen).
 * Because the switch is boot-only, flipping either condition takes effect on the NEXT
 * launch — the Settings panel surfaces that.
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

/**
 * Pure gate predicate: the unauthenticated CDP port opens only when BOTH a
 * browser-control MCP server is enabled (`argCondition`) AND the user has explicitly
 * opted in (`settingEnabled`, default OFF). Extracted so the dangerous decision is
 * unit-testable in isolation, with no Electron/app dependency.
 */
export function shouldOpenDebugPort(argCondition: boolean, settingEnabled: boolean): boolean {
  return argCondition && settingEnabled;
}

/** Set once at boot in {@link maybeOpenEmbeddedDebugPort}; read by the Settings status. */
let portOpen = false;

/**
 * Open Chromium's remote-debugging endpoint on a fixed loopback port (127.0.0.1) — but
 * ONLY when both the MCP arg condition and the user opt-in hold (see
 * {@link shouldOpenDebugPort}). MUST be called before `app.whenReady()` (the switch has
 * no runtime API); reads the config + settings synchronously since that path can't await.
 */
export function maybeOpenEmbeddedDebugPort(): void {
  const argCondition = configWantsEmbeddedDebug(readMcpConfigSync());
  const settingEnabled = readSettingsSync().browser.allowDebugPort;
  // SECURITY GATE: never open the unauthenticated CDP port on the MCP arg condition
  // alone — it requires the explicit, default-OFF user opt-in too.
  if (!shouldOpenDebugPort(argCondition, settingEnabled)) return;
  app.commandLine.appendSwitch('remote-debugging-port', String(EMBEDDED_CHROMIUM_DEBUG_PORT));
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  portOpen = true;
}

/**
 * Status for Settings → MCP Servers and the title-bar badge. `required` is whether the
 * LIVE config now wants the embedded debug port; `allowed` is the user opt-in
 * (`browser.allowDebugPort`); `portOpen` is whether we actually opened it this launch.
 * `required && allowed && !portOpen` means the user enabled browser control this session
 * and must restart for it to attach. `required && !allowed` means a browser-control
 * server is on but the security opt-in is off, so the port stays closed.
 */
export async function embeddedBrowserDebugStatus(): Promise<{
  portOpen: boolean;
  required: boolean;
  allowed: boolean;
}> {
  const [file, settings] = await Promise.all([readMcpConfig(), getSettings()]);
  return {
    portOpen,
    required: configWantsEmbeddedDebug(file),
    allowed: settings.browser.allowDebugPort,
  };
}
