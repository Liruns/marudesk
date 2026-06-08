import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  DEFAULT_SSH_PORT,
  type SshAuth,
  type SshAuthMethod,
  type SshConnectionId,
  type SshConnectionInfo,
  type SshConnectionInput,
} from '../../shared/ssh';
import { toMessage } from '../../shared/to-message';
import {
  discoverLocalSshConfigConnections,
  type DiscoveredSshConfigConnection,
} from './config-discovery';

/**
 * In-memory registry of configured SSH hosts and their live sessions.
 *
 * Secrets (private-key passphrase, password) are held only here in the main
 * process and never cross back over IPC — the renderer only ever sees the
 * sanitized {@link SshConnectionInfo}. Connections are lazy: a Client is opened
 * on first SFTP/exec use and reused; a dropped connection reconnects on demand.
 *
 * SECURITY TODO: host keys are currently accepted on first sight (no known_hosts
 * / TOFU verification). A future pass should persist + compare host fingerprints
 * to defend against MITM. The fingerprint is surfaced from probes so the UI can
 * eventually pin it.
 */

const EXEC_MAX_OUTPUT = 64 * 1024 * 1024;
/** Bound on a single remote command (mirrors the local indexer's git timeout). */
const EXEC_TIMEOUT_MS = 15_000;

type ManagedConnection = {
  info: Omit<SshConnectionInfo, 'connected'>;
  auth: SshAuth;
  client: Client | null;
  sftp: SFTPWrapper | null;
  /** De-dupes concurrent connects so callers share one handshake. */
  pending: Promise<SFTPWrapper> | null;
};

const connections = new Map<SshConnectionId, ManagedConnection>();

function authMethodOf(auth: SshAuth): SshAuthMethod {
  return auth.method;
}

function defaultAgentPath(): string | undefined {
  if (process.platform === 'win32') return 'pageant';
  return process.env.SSH_AUTH_SOCK || undefined;
}

/** Build the ssh2 connect options from a stored auth method (reads the key file). */
async function buildConnectConfig(
  base: { host: string; port: number; username: string },
  auth: SshAuth,
): Promise<ConnectConfig> {
  const config: ConnectConfig = {
    host: base.host,
    port: base.port,
    username: base.username,
    // First-use host key acceptance (see SECURITY TODO above).
    hostVerifier: () => true,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
  };
  switch (auth.method) {
    case 'agent': {
      const agent = defaultAgentPath();
      if (!agent) {
        throw new Error(
          'no SSH agent available (SSH_AUTH_SOCK is unset); pick key-file or password auth',
        );
      }
      config.agent = agent;
      break;
    }
    case 'key': {
      let privateKey: Buffer;
      try {
        privateKey = await fs.readFile(auth.privateKeyPath);
      } catch (err) {
        throw new Error(
          `cannot read private key file: ${toMessage(err)}`,
          { cause: err },
        );
      }
      config.privateKey = privateKey;
      if (auth.passphrase) config.passphrase = auth.passphrase;
      break;
    }
    case 'password': {
      config.password = auth.password;
      break;
    }
  }
  return config;
}

/** Open a fresh SSH client + SFTP channel for the given config. */
function openClient(
  config: ConnectConfig,
): Promise<{ client: Client; sftp: SFTPWrapper }> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    client.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    client.on('ready', () => {
      client.sftp((err, sftp) => {
        if (settled) return;
        if (err) {
          settled = true;
          client.end();
          reject(err);
          return;
        }
        settled = true;
        resolve({ client, sftp });
      });
    });
    client.connect(config);
  });
}

/** Resolve a stored connection or throw a stable "not found" error. */
function requireConn(id: SshConnectionId): ManagedConnection {
  const conn = connections.get(id);
  if (!conn) throw new Error(`ssh connection not found: ${id}`);
  return conn;
}

function detach(conn: ManagedConnection): void {
  const client = conn.client;
  // Clear the fields first so the 'close' that `end()` triggers re-enters here
  // as a no-op (the live-session listeners are guarded by identity).
  conn.client = null;
  conn.sftp = null;
  conn.pending = null;
  if (client) {
    // Drop the teardown listeners but keep a no-op 'error' sink: ending an
    // already-broken client can still emit 'error', which with no listener is
    // an uncaught exception that crashes the main process.
    client.removeAllListeners('close');
    client.removeAllListeners('error');
    client.on('error', () => undefined);
    try {
      client.end();
    } catch {
      // best-effort teardown
    }
  }
}

/** Get a live SFTP channel for a stored connection, connecting if needed. */
export async function ensureSftp(id: SshConnectionId): Promise<SFTPWrapper> {
  const conn = requireConn(id);
  if (conn.sftp && conn.client) return conn.sftp;
  if (!conn.pending) {
    // Resolve to the live SFTP. The client/sftp fields are assigned INSIDE the
    // factory (before resolve) so concurrent awaiters never observe a window
    // where the handshake finished but the connection isn't recorded — which
    // would let a second caller open a duplicate, leaked client. `pending` is
    // cleared only on failure; on success it's harmless (the cached-handle
    // check above short-circuits) and `detach` clears it on disconnect.
    conn.pending = (async () => {
      const config = await buildConnectConfig(conn.info, conn.auth);
      const opened = await openClient(config);
      // Keep an error handler attached for the connection's whole life: an
      // EventEmitter 'error' with no listener is an uncaught exception that
      // would crash the main process. Both error and close tear the session
      // down so the next op reconnects.
      const drop = (): void => {
        if (conn.client === opened.client) detach(conn);
      };
      opened.client.on('error', drop);
      opened.client.on('close', drop);
      conn.client = opened.client;
      conn.sftp = opened.sftp;
      return opened.sftp;
    })();
  }
  try {
    return await conn.pending;
  } catch (err) {
    conn.pending = null;
    throw err;
  }
}

/** Run a command on the host and collect its output (bounded). */
export async function execCommand(
  id: SshConnectionId,
  command: string,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  await ensureSftp(id);
  const conn = requireConn(id);
  const client = conn.client;
  if (!client) throw new Error('ssh connection is not open');
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      const chunks: Buffer[] = [];
      const errParts: string[] = [];
      let total = 0;
      let overflowed = false;
      let timedOut = false;
      // A stuck/slow remote command must not hang the indexer forever (the
      // local git path has its own timeout). Force the channel closed and fail.
      const timer = setTimeout(() => {
        timedOut = true;
        stream.close();
      }, EXEC_TIMEOUT_MS);
      stream.on('data', (data: Buffer) => {
        total += data.length;
        if (total > EXEC_MAX_OUTPUT) {
          overflowed = true;
          stream.close();
          return;
        }
        chunks.push(data);
      });
      stream.stderr.on('data', (data: Buffer) => {
        errParts.push(data.toString('utf8'));
      });
      stream.on('error', (streamErr: Error) => {
        clearTimeout(timer);
        reject(streamErr);
      });
      stream.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error('ssh command timed out'));
          return;
        }
        if (overflowed) {
          reject(new Error('ssh command output exceeded the size limit'));
          return;
        }
        resolve({
          code: code ?? 0,
          stdout: Buffer.concat(chunks),
          stderr: errParts.join(''),
        });
      });
    });
  });
}

export function addConnection(input: SshConnectionInput): SshConnectionInfo {
  const host = input.host.trim();
  if (!host) throw new Error('ssh host must not be empty');
  const username = input.username.trim();
  if (!username) throw new Error('ssh username must not be empty');
  const port = input.port ?? DEFAULT_SSH_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ssh port must be an integer in 1..65535');
  }
  const id = `ssh-${randomUUID()}`;
  const label = input.label?.trim() || `${username}@${host}`;
  const conn: ManagedConnection = {
    info: {
      id,
      label,
      host,
      port,
      username,
      authMethod: authMethodOf(input.auth),
      source: 'manual',
    },
    auth: input.auth,
    client: null,
    sftp: null,
    pending: null,
  };
  connections.set(id, conn);
  return { ...conn.info, connected: false };
}

export function removeConnection(id: SshConnectionId): void {
  const conn = connections.get(id);
  if (!conn) return;
  detach(conn);
  connections.delete(id);
}

export function listConnections(): SshConnectionInfo[] {
  syncDiscoveredConfigConnections();
  return [...connections.values()].map((conn) => ({
    ...conn.info,
    connected: conn.client !== null && conn.sftp !== null,
  }));
}

export function getConnectionInfo(id: SshConnectionId): SshConnectionInfo {
  syncDiscoveredConfigConnections();
  const conn = requireConn(id);
  return { ...conn.info, connected: conn.client !== null && conn.sftp !== null };
}

function syncDiscoveredConfigConnections(): void {
  const discovered = discoverLocalSshConfigConnections();
  const discoveredIds = new Set(discovered.map((entry) => entry.info.id));
  for (const [id, conn] of connections) {
    if (conn.info.source === 'ssh-config' && !discoveredIds.has(id)) {
      detach(conn);
      connections.delete(id);
    }
  }
  for (const entry of discovered) {
    const existing = connections.get(entry.info.id);
    if (existing && !configConnectionChanged(existing, entry)) continue;
    if (existing) detach(existing);
    connections.set(entry.info.id, {
      info: storedInfo(entry.info),
      auth: entry.auth,
      client: null,
      sftp: null,
      pending: null,
    });
  }
}

function storedInfo(info: SshConnectionInfo): Omit<SshConnectionInfo, 'connected'> {
  return {
    id: info.id,
    label: info.label,
    host: info.host,
    port: info.port,
    username: info.username,
    authMethod: info.authMethod,
    source: info.source,
  };
}

function configConnectionChanged(
  existing: ManagedConnection,
  discovered: DiscoveredSshConfigConnection,
): boolean {
  const info = discovered.info;
  return (
    existing.info.label !== info.label ||
    existing.info.host !== info.host ||
    existing.info.port !== info.port ||
    existing.info.username !== info.username ||
    existing.info.authMethod !== info.authMethod ||
    authSignature(existing.auth) !== authSignature(discovered.auth)
  );
}

function authSignature(auth: SshAuth): string {
  switch (auth.method) {
    case 'agent':
      return 'agent';
    case 'key':
      return `key:${auth.privateKeyPath}:${auth.passphrase ?? ''}`;
    case 'password':
      return `password:${auth.password}`;
  }
}

/**
 * Probe a (possibly unsaved) connection: open a throwaway session and resolve
 * the remote home directory. Used by the "Test connection" affordance and to
 * pre-fill the remote folder picker.
 */
export async function probeConnection(
  input: SshConnectionInput,
): Promise<{ homeDir: string }> {
  const port = input.port ?? DEFAULT_SSH_PORT;
  const config = await buildConnectConfig(
    { host: input.host.trim(), port, username: input.username.trim() },
    input.auth,
  );
  const { client, sftp } = await openClient(config);
  try {
    const homeDir = await new Promise<string>((resolve, reject) => {
      sftp.realpath('.', (err, absPath) => {
        if (err) reject(err);
        else resolve(absPath);
      });
    });
    return { homeDir };
  } finally {
    client.end();
  }
}
