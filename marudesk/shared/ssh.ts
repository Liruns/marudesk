/**
 * SSH remote-workspace contract shared across main, renderer, and tests.
 *
 * A connection is a configured host (label + host/port/user + an auth method).
 * Secrets (private-key passphrase, password) live ONLY in the main process: they
 * cross IPC inbound when the user adds/tests a connection, but are never returned
 * to the renderer — only the sanitized {@link SshConnectionInfo} crosses back.
 *
 * A remote workspace root pairs a connection id with an absolute POSIX path on
 * that host; the file-op router keys on the root string to pick the SFTP backend
 * (see electron/ssh/*). Remote indexing/reads mirror the local path-safety
 * contract (relative-only, no traversal, symlink-refused) against the remote root.
 */

export type SshConnectionId = string;
export type SshConnectionSource = 'manual' | 'ssh-config';

/** How marudesk authenticates to the host. Secrets stay main-side. */
export type SshAuth =
  | { method: 'agent' }
  | { method: 'key'; privateKeyPath: string; passphrase?: string }
  | { method: 'password'; password: string };

/** The auth method name, safe to surface to the renderer (no secret material). */
export type SshAuthMethod = SshAuth['method'];

/** Inbound payload to add/test a connection (carries secrets — main-only after IPC). */
export type SshConnectionInput = {
  label?: string;
  host: string;
  port?: number;
  username: string;
  auth: SshAuth;
};

/** Sanitized connection view returned to the renderer (NEVER includes secrets). */
export type SshConnectionInfo = {
  id: SshConnectionId;
  label: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  source: SshConnectionSource;
  /** True when a live SSH/SFTP session is currently open. */
  connected: boolean;
};

/** Result of probing a connection: the resolved remote home dir, or why it failed. */
export type SshTestResult =
  | { ok: true; homeDir: string }
  | { ok: false; reason: string };

/** A single remote directory entry for the lightweight remote folder picker. */
export type SshDirEntry = {
  name: string;
  kind: 'dir' | 'file' | 'symlink' | 'other';
};

/** Result of listing a remote directory (path is the absolute POSIX dir listed). */
export type SshListDirResult =
  | { ok: true; path: string; entries: SshDirEntry[] }
  | { ok: false; reason: string };

export const DEFAULT_SSH_PORT = 22;

/** A remote root's opaque identity string: `ssh://<connId><absPosixPath>`. */
export function sshRootKey(connectionId: SshConnectionId, remotePath: string): string {
  return `ssh://${connectionId}${remotePath}`;
}

/** True when a workspace root string addresses a remote (SSH) backend. */
export function isSshRootKey(root: string): boolean {
  return root.startsWith('ssh://');
}
