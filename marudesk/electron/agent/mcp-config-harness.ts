import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ipcMain } from 'electron';
import type { McpServerStatus } from '../../shared/mcp';
import { MCP_PRESETS } from '../../shared/mcp-presets';
import {
  mcpConfigPath,
  readMcpConfig,
  writeMcpConfig,
} from './mcp-config';
import { registerMcpHandlers, shutdownExternalMcp } from './mcp-handlers';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>;

const handlers = new Map<string, IpcHandler>();
const ipc = ipcMain as unknown as { handle: (channel: string, handler: IpcHandler) => void };
ipc.handle = (channel, handler) => {
  handlers.set(channel, handler);
};

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
  const browserPreset = MCP_PRESETS.find((preset) => preset.id === 'chrome-devtools');
  assert.ok(browserPreset, 'chrome-devtools preset exists');
  (browserPreset.config as { enabled: boolean }).enabled = false;

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
  const embeddedStatus = embedded as { portOpen?: unknown; required?: unknown };
  check('embedded-browser-status reports required=true for the browser preset', embeddedStatus.required === true);
  check('embedded-browser-status returns a boolean portOpen flag', typeof embeddedStatus.portOpen === 'boolean');

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
