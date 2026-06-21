import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ipcMain, shell } from 'electron';
import type { McpConfigHealth, McpServerStatus } from '../../shared/mcp';
import { MCP_PRESETS } from '../../shared/mcp-presets';
import {
  mcpConfigPath,
  readMcpConfig,
  readMcpConfigHealth,
  writeMcpConfig,
} from './mcp-config';
import { registerMcpHandlers, shutdownExternalMcp } from './mcp-handlers';
import { shouldOpenDebugPort } from './embedded-browser';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>;

const handlers = new Map<string, IpcHandler>();
const ipc = ipcMain as unknown as { handle: (channel: string, handler: IpcHandler) => void };
ipc.handle = (channel, handler) => {
  handlers.set(channel, handler);
};
const electronShell = shell as unknown as {
  openPath: (filePath: string) => Promise<string>;
  showItemInFolder: (filePath: string) => void;
};
electronShell.openPath = async () => '';
electronShell.showItemInFolder = () => {};

let passed = 0;

function check(label: string, condition: boolean): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

function checkEqual<T>(label: string, actual: T, expected: T): void {
  assert.deepEqual(actual, expected, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

async function checkRejects(
  label: string,
  run: () => Promise<unknown>,
  expected: RegExp,
): Promise<void> {
  await assert.rejects(run, expected);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

async function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  assert.ok(handler, `handler registered for ${channel}`);
  return handler({}, ...(payload === undefined ? [] : [payload]));
}

async function invokeStatus(channel: string, payload?: unknown): Promise<McpServerStatus[]> {
  const value = await invoke(channel, payload);
  assert.ok(Array.isArray(value), `${channel} returned a status list`);
  return value as McpServerStatus[];
}

async function invokeHealth(channel: string): Promise<McpConfigHealth> {
  const value = await invoke(channel);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${channel} returned health`);
  return value as McpConfigHealth;
}

function statusById(statuses: McpServerStatus[], id: string): McpServerStatus {
  const status = statuses.find((s) => s.id === id);
  assert.ok(status, `status exists for ${id}`);
  return status;
}

function stableConfig(): Promise<string> {
  return readMcpConfig().then((file) => JSON.stringify(file));
}

async function resetHarnessConfig(): Promise<void> {
  const dir = path.dirname(mcpConfigPath());
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

await resetHarnessConfig();
registerMcpHandlers();

try {
  const missingHealth = await invokeHealth('mcp:config-diagnostics');
  check('config diagnostics reports missing config as ok', missingHealth.ok && !missingHealth.exists);
  checkEqual('missing config has no diagnostics', missingHealth.diagnostics, []);

  await fs.writeFile(mcpConfigPath(), '{ "servers": [', 'utf8');
  const corruptHealth = await invokeHealth('mcp:config-diagnostics');
  check('config diagnostics reports corrupt JSON as not ok', corruptHealth.ok === false);
  check('config diagnostics includes parse_error', corruptHealth.diagnostics.some((d) => d.code === 'parse_error'));
  const corruptReload = await invokeStatus('mcp:reload');
  checkEqual('reload fail-closes corrupt JSON to no statuses', corruptReload, []);
  const opened = await invoke('mcp:open-config');
  assert.ok(opened && typeof opened === 'object' && !Array.isArray(opened), 'open-config returned an object');
  check('open-config still returns the config path for corrupt JSON', (opened as { path?: unknown }).path === mcpConfigPath());
  const directCorruptHealth = await readMcpConfigHealth();
  check('readMcpConfigHealth sees parse_error after open-config', directCorruptHealth.diagnostics.some((d) => d.code === 'parse_error'));

  const browserPreset = MCP_PRESETS.find((preset) => preset.id === 'chrome-devtools');
  assert.ok(browserPreset, 'chrome-devtools preset exists');
  (browserPreset.config as { enabled: boolean }).enabled = false;

  await writeMcpConfig({
    servers: [
      {
        id: 'policy',
        command: 'node',
        enabled: false,
        disabledTools: ['danger', 'danger'],
        confirmTools: ['danger', 'review'],
        autoApproveTools: ['danger', 'review', 'safe'],
      },
    ],
  });
  const normalizedPolicy = (await readMcpConfig()).servers.find((s) => s.id === 'policy');
  assert.ok(normalizedPolicy, 'policy config exists');
  checkEqual('write normalizes disabledTools', normalizedPolicy.disabledTools ?? [], ['danger']);
  checkEqual('write removes disabled tools from confirmTools', normalizedPolicy.confirmTools ?? [], ['review']);
  checkEqual('write removes disabled/confirm tools from autoApproveTools', normalizedPolicy.autoApproveTools ?? [], ['safe']);

  await fs.writeFile(
    mcpConfigPath(),
    JSON.stringify(
      {
        servers: [
          { id: 'bad space', command: 'node' },
          {
            id: 'dup',
            command: 'node',
            enabled: false,
            disabledTools: ['danger'],
            confirmTools: ['danger', 'review'],
            autoApproveTools: ['danger', 'review', 'safe'],
          },
          { id: 'dup', command: 'node', enabled: false },
          { id: 'badUrl', transport: 'http', url: 'file:///tmp/mcp' },
          { id: 'noCommand' },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
  const invalidHealth = await invokeHealth('mcp:config-diagnostics');
  const invalidCodes = new Set(invalidHealth.diagnostics.map((d) => d.code));
  check('config diagnostics marks invalid sanitized config as not ok', invalidHealth.ok === false);
  check('config diagnostics reports invalid_id', invalidCodes.has('invalid_id'));
  check('config diagnostics reports duplicate_id', invalidCodes.has('duplicate_id'));
  check('config diagnostics reports invalid_url', invalidCodes.has('invalid_url'));
  check('config diagnostics reports missing_command', invalidCodes.has('missing_command'));
  check('config diagnostics reports policy_conflict', invalidCodes.has('policy_conflict'));
  const sanitizedStatuses = await invokeStatus('mcp:reload');
  checkEqual('reload keeps only valid sanitized config rows', sanitizedStatuses.map((s) => s.id), ['dup']);
  const sanitizedDup = statusById(sanitizedStatuses, 'dup');
  checkEqual('sanitized status removes disabled tools from confirmTools', sanitizedDup.confirmTools, ['review']);
  checkEqual('sanitized status removes disabled/confirm tools from autoApproveTools', sanitizedDup.autoApproveTools, ['safe']);

  await writeMcpConfig({
    servers: [
      { id: 'local', command: 'node', args: ['server.js'], enabled: true },
      {
        id: 'remote',
        transport: 'http',
        url: 'https://example.com/mcp?token=secret',
        enabled: false,
      },
    ],
  });

  const disabledByToggle = await invokeStatus('mcp:set-enabled', {
    id: 'local',
    enabled: false,
  });
  check('set-enabled IPC disables an existing server', statusById(disabledByToggle, 'local').enabled === false);

  const presetStatuses = await invokeStatus('mcp:add-preset', { id: browserPreset.id });
  check('add-preset IPC writes the curated browser preset', presetStatuses.some((s) => s.id === browserPreset.id));
  check(
    'add-preset IPC returns a disabled preset status without spawning it',
    statusById(presetStatuses, browserPreset.id).state === 'disabled',
  );
  check('add-preset persists the preset config', (await readMcpConfig()).servers.some((s) => s.id === browserPreset.id));
  await invokeStatus('mcp:remove-server', { id: browserPreset.id });

  await writeMcpConfig({
    servers: [{ ...browserPreset.config, enabled: true }],
  });
  const embedded = await invoke('mcp:embedded-browser-status');
  assert.ok(embedded && typeof embedded === 'object' && !Array.isArray(embedded), 'embedded status is an object');
  const embeddedStatus = embedded as { portOpen?: unknown; required?: unknown; allowed?: unknown };
  check('embedded-browser-status reports required=true for the browser preset', embeddedStatus.required === true);
  check('embedded-browser-status returns a boolean portOpen flag', typeof embeddedStatus.portOpen === 'boolean');
  check('embedded-browser-status returns a boolean allowed (opt-in) flag', typeof embeddedStatus.allowed === 'boolean');

  // SECURITY GATE: the unauthenticated CDP debug port opens only when BOTH the MCP arg
  // condition AND the explicit user opt-in are true — neither alone is sufficient.
  check('debug port stays closed when only the MCP arg condition is met (opt-in off)', shouldOpenDebugPort(true, false) === false);
  check('debug port stays closed when only the opt-in is on (no browser-control server)', shouldOpenDebugPort(false, true) === false);
  check('debug port stays closed when neither condition is met', shouldOpenDebugPort(false, false) === false);
  check('debug port opens only when the arg condition AND the opt-in both hold', shouldOpenDebugPort(true, true) === true);

  await writeMcpConfig({
    servers: [
      { id: 'local', command: 'node', args: ['server.js'], enabled: false },
      {
        id: 'remote',
        transport: 'http',
        url: 'https://example.com/mcp?token=secret',
        enabled: false,
      },
    ],
  });

  const statuses = await invokeStatus('mcp:update-server', {
    id: 'local',
    enabled: false,
    trust: true,
    disabledTools: [' delete ', 'delete', ''],
    autoApproveTools: ['read', ' read '],
    confirmTools: ['deploy', 'deploy', ' '],
  });
  const localStatus = statusById(statuses, 'local');
  check('update IPC returns disabled local status', localStatus.state === 'disabled');
  check('update IPC persists enabled=false', localStatus.enabled === false);
  check('update IPC returns trusted=true', localStatus.trusted === true);
  checkEqual('disabledTools are trimmed and de-duped in status', localStatus.disabledTools, [
    'delete',
  ]);
  checkEqual('autoApproveTools are trimmed and de-duped in status', localStatus.autoApproveTools, [
    'read',
  ]);
  checkEqual('confirmTools are trimmed and de-duped in status', localStatus.confirmTools, [
    'deploy',
  ]);

  const updatedConfig = await readMcpConfig();
  const updatedLocal = updatedConfig.servers.find((s) => s.id === 'local');
  assert.ok(updatedLocal, 'local config exists');
  checkEqual('disabledTools are sanitized before persistence', updatedLocal.disabledTools ?? [], [
    'delete',
  ]);
  checkEqual('autoApproveTools are sanitized before persistence', updatedLocal.autoApproveTools ?? [], [
    'read',
  ]);
  checkEqual('confirmTools are sanitized before persistence', updatedLocal.confirmTools ?? [], [
    'deploy',
  ]);

  await checkRejects(
    'malformed update payload rejects non-boolean trust',
    () => invoke('mcp:update-server', { id: 'local', trust: 'yes' }),
    /trust must be a boolean/,
  );
  await checkRejects(
    'malformed update payload rejects non-array tool lists',
    () => invoke('mcp:update-server', { id: 'local', disabledTools: 'delete' }),
    /disabledTools must be an array/,
  );
  await checkRejects(
    'malformed update payload rejects non-string tool names',
    () => invoke('mcp:update-server', { id: 'local', confirmTools: [1] }),
    /confirmTools\[0\] must be a string/,
  );

  const beforeUnknownUpdate = await stableConfig();
  await invokeStatus('mcp:update-server', {
    id: 'missing',
    trust: true,
    disabledTools: ['ignored'],
  });
  check('unknown update id leaves config unchanged', (await stableConfig()) === beforeUnknownUpdate);

  await checkRejects(
    'malformed remove payload rejects blank ids',
    () => invoke('mcp:remove-server', { id: '' }),
    /id must not be empty/,
  );

  const afterRemove = await invokeStatus('mcp:remove-server', { id: 'remote' });
  check('remove IPC drops the server status row', !afterRemove.some((s) => s.id === 'remote'));
  check('remove IPC drops the server from config', !(await readMcpConfig()).servers.some((s) => s.id === 'remote'));

  const beforeUnknownRemove = await stableConfig();
  await invokeStatus('mcp:remove-server', { id: 'missing' });
  check('unknown remove id leaves config unchanged', (await stableConfig()) === beforeUnknownRemove);

  console.log(`\nmcp config harness: ${passed} assertions passed`);
} finally {
  await shutdownExternalMcp();
  await resetHarnessConfig();
}
