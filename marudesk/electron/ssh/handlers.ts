import type { SshAuth, SshConnectionInput, SshDirEntry } from '../../shared/ssh';
import { defineHandler } from '../ipc/define-handler';
import { enumOf, nonEmptyStr, num, obj, optStr, str } from '../ipc/validate';
import {
  addConnection,
  ensureSftp,
  listConnections,
  probeConnection,
  removeConnection,
} from './connection-manager';
import { readdir, realpath } from './sftp';

/** Validate an untrusted auth blob into a typed {@link SshAuth}. */
function toSshAuth(value: unknown): SshAuth {
  const p = obj(value, 'auth');
  const method = enumOf(p.method, ['agent', 'key', 'password'] as const, 'auth.method');
  if (method === 'agent') return { method: 'agent' };
  if (method === 'key') {
    return {
      method: 'key',
      privateKeyPath: nonEmptyStr(p.privateKeyPath, 'auth.privateKeyPath'),
      passphrase: optStr(p.passphrase, 'auth.passphrase'),
    };
  }
  return { method: 'password', password: str(p.password, 'auth.password') };
}

function toSshInput(value: unknown): SshConnectionInput {
  const p = obj(value, 'input');
  return {
    label: optStr(p.label, 'label'),
    host: nonEmptyStr(p.host, 'host'),
    port: p.port === undefined ? undefined : num(p.port, 'port'),
    username: nonEmptyStr(p.username, 'username'),
    auth: toSshAuth(p.auth),
  };
}

export function registerSshHandlers(): void {
  defineHandler('ssh:list-connections', () => listConnections());

  defineHandler('ssh:add-connection', ([input]) => addConnection(toSshInput(input)));

  defineHandler('ssh:remove-connection', ([payload]) => {
    const p = obj(payload);
    removeConnection(str(p.connectionId, 'connectionId'));
    return { ok: true as const };
  });

  defineHandler('ssh:test-connection', async ([input]) => {
    try {
      const { homeDir } = await probeConnection(toSshInput(input));
      return { ok: true as const, homeDir };
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
    }
  });

  defineHandler('ssh:list-dir', async ([payload]) => {
    const p = obj(payload);
    const connectionId = str(p.connectionId, 'connectionId');
    const dir = nonEmptyStr(p.path, 'path');
    try {
      const sftp = await ensureSftp(connectionId);
      // Resolve '.'/'~'-style and relative inputs to an absolute path so the
      // renderer can prefill the remote-root field (e.g. list-dir('.') → home).
      const abs = await realpath(sftp, dir);
      const entries = await readdir(sftp, abs);
      const mapped: SshDirEntry[] = entries.map((entry) => ({
        name: entry.filename,
        kind: entry.attrs.isSymbolicLink()
          ? 'symlink'
          : entry.attrs.isDirectory()
            ? 'dir'
            : entry.attrs.isFile()
              ? 'file'
              : 'other',
      }));
      mapped.sort((a, b) => {
        if (a.kind === 'dir' && b.kind !== 'dir') return -1;
        if (a.kind !== 'dir' && b.kind === 'dir') return 1;
        return a.name.localeCompare(b.name);
      });
      return { ok: true as const, path: abs, entries: mapped };
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
    }
  });
}
