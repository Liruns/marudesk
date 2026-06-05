import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  SshAuth,
  SshAuthMethod,
  SshConnectionInfo,
} from '../../../shared/ssh';
import { DEFAULT_SSH_PORT } from '../../../shared/ssh';
import type { WorkspaceId } from '../../../shared/workspace';
import { cn } from '../../lib/cn';
import { toMessage } from '../../lib/toMessage';
import { useWorkspaceDeckStore } from './store';

/**
 * Add a folder on an SSH host as a new root of a workspace. Lists saved
 * connections, lets the user define a new one (key file / password / agent),
 * probes it, and adds a chosen remote path. Secrets are sent to main only — the
 * renderer never holds them after submit. Mirrors NameDialog's portal + browser
 * hide/restore so the dialog composites above the embedded web view.
 */
export function SshRootDialog({
  workspaceId,
  onClose,
}: {
  workspaceId: WorkspaceId;
  onClose: () => void;
}) {
  const addSshRoot = useWorkspaceDeckStore((s) => s.addSshRoot);

  const [connections, setConnections] = useState<SshConnectionInfo[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(DEFAULT_SSH_PORT));
  const [username, setUsername] = useState('');
  const [authMethod, setAuthMethod] = useState<SshAuthMethod>('agent');
  const [privateKeyPath, setPrivateKeyPath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');

  const [remotePath, setRemotePath] = useState('');
  const [rootName, setRootName] = useState('');

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    void window.marudesk.invoke('browser:set-visible', false);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      void window.marudesk.invoke('browser:set-visible', true);
    };
  }, [onClose]);

  useEffect(() => {
    let active = true;
    void window.marudesk
      .invoke('ssh:list-connections')
      .then((list) => {
        if (!active) return;
        setConnections(list);
        setShowNew(list.length === 0);
        setConnectionId(list[0]?.id ?? null);
      })
      .catch((err) => active && setError(toMessage(err)));
    return () => {
      active = false;
    };
  }, []);

  const buildAuth = (): SshAuth => {
    if (authMethod === 'key') {
      return {
        method: 'key',
        privateKeyPath: privateKeyPath.trim(),
        passphrase: passphrase || undefined,
      };
    }
    if (authMethod === 'password') return { method: 'password', password };
    return { method: 'agent' };
  };

  const newConnectionValid =
    host.trim().length > 0 &&
    username.trim().length > 0 &&
    (authMethod !== 'key' || privateKeyPath.trim().length > 0) &&
    (authMethod !== 'password' || password.length > 0);

  /** Probe + save a new connection, then select it and prefill its home dir. */
  const connectNew = async () => {
    setBusy(true);
    setError(null);
    setStatus('Connecting…');
    try {
      const input = {
        label: label.trim() || undefined,
        host: host.trim(),
        port: Number(port) || DEFAULT_SSH_PORT,
        username: username.trim(),
        auth: buildAuth(),
      };
      const test = await window.marudesk.invoke('ssh:test-connection', input);
      if (!test.ok) {
        setError(test.reason);
        setStatus(null);
        return;
      }
      const info = await window.marudesk.invoke('ssh:add-connection', input);
      setConnections((prev) => [...prev, info]);
      setConnectionId(info.id);
      setShowNew(false);
      setRemotePath(test.homeDir);
      setStatus(`Connected — home is ${test.homeDir}`);
      // Clear secrets from renderer state now that main owns them.
      setPassword('');
      setPassphrase('');
    } catch (err) {
      setError(toMessage(err));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  /** Resolve the selected connection's home dir into the remote-path field. */
  const fillHomePath = async () => {
    if (!connectionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.marudesk.invoke('ssh:list-dir', {
        connectionId,
        path: '.',
      });
      if (res.ok) setRemotePath(res.path);
      else setError(res.reason);
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!connectionId || !remotePath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const record = await addSshRoot(workspaceId, {
        connectionId,
        remotePath: remotePath.trim(),
        name: rootName.trim() || undefined,
      });
      if (record) onClose();
      else setError(useWorkspaceDeckStore.getState().error ?? 'Failed to add remote folder.');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label="Add SSH folder"
        onMouseDown={(event) => event.stopPropagation()}
        className="w-[420px] max-h-[88vh] overflow-y-auto rounded-lg bg-surface-1 border border-default shadow-lifted p-4 flex flex-col gap-3"
      >
        <h2 className="text-body font-semibold text-fg-primary">Add SSH folder</h2>

        {connections.length > 0 && !showNew ? (
          <Field label="Connection">
            <div className="flex gap-2">
              <select
                value={connectionId ?? ''}
                onChange={(event) => setConnectionId(event.currentTarget.value)}
                className={inputClass}
              >
                {connections.map((conn) => (
                  <option key={conn.id} value={conn.id}>
                    {conn.label} ({conn.username}@{conn.host}:{conn.port})
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setShowNew(true)} className={ghostBtn}>
                New…
              </button>
            </div>
          </Field>
        ) : null}

        {showNew ? (
          <div className="flex flex-col gap-2 rounded-md border border-subtle p-3">
            <div className="flex items-center justify-between">
              <span className="text-caption font-medium text-fg-secondary uppercase">
                New connection
              </span>
              {connections.length > 0 ? (
                <button type="button" onClick={() => setShowNew(false)} className={ghostBtn}>
                  Cancel
                </button>
              ) : null}
            </div>
            <Field label="Label (optional)">
              <input value={label} onChange={(e) => setLabel(e.currentTarget.value)} className={inputClass} placeholder="my-server" />
            </Field>
            <div className="flex gap-2">
              <div className="flex-1">
                <Field label="Host">
                  <input value={host} onChange={(e) => setHost(e.currentTarget.value)} className={inputClass} placeholder="example.com" />
                </Field>
              </div>
              <div className="w-20">
                <Field label="Port">
                  <input value={port} onChange={(e) => setPort(e.currentTarget.value)} className={inputClass} inputMode="numeric" />
                </Field>
              </div>
            </div>
            <Field label="Username">
              <input value={username} onChange={(e) => setUsername(e.currentTarget.value)} className={inputClass} placeholder="ubuntu" />
            </Field>
            <Field label="Authentication">
              <select
                value={authMethod}
                onChange={(e) => {
                  // Drop any entered secret when leaving a method so it doesn't
                  // linger in renderer state after the user changes their mind.
                  setPassword('');
                  setPassphrase('');
                  setAuthMethod(e.currentTarget.value as SshAuthMethod);
                }}
                className={inputClass}
              >
                <option value="agent">SSH agent</option>
                <option value="key">Private key file</option>
                <option value="password">Password</option>
              </select>
            </Field>
            {authMethod === 'key' ? (
              <>
                <Field label="Private key path">
                  <input value={privateKeyPath} onChange={(e) => setPrivateKeyPath(e.currentTarget.value)} className={inputClass} placeholder="~/.ssh/id_ed25519" />
                </Field>
                <Field label="Passphrase (optional)">
                  <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.currentTarget.value)} className={inputClass} />
                </Field>
              </>
            ) : null}
            {authMethod === 'password' ? (
              <Field label="Password">
                <input type="password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} className={inputClass} />
              </Field>
            ) : null}
            <button
              type="button"
              onClick={() => void connectNew()}
              disabled={busy || !newConnectionValid}
              className={primaryBtn}
            >
              {busy ? 'Connecting…' : 'Connect & save'}
            </button>
          </div>
        ) : null}

        {!showNew && connectionId ? (
          <>
            <Field label="Remote folder path">
              <div className="flex gap-2">
                <input
                  value={remotePath}
                  onChange={(e) => setRemotePath(e.currentTarget.value)}
                  className={inputClass}
                  placeholder="/home/ubuntu/project"
                />
                <button type="button" onClick={() => void fillHomePath()} disabled={busy} className={ghostBtn}>
                  Home
                </button>
              </div>
            </Field>
            <Field label="Root name (optional)">
              <input value={rootName} onChange={(e) => setRootName(e.currentTarget.value)} className={inputClass} placeholder="defaults to folder name" />
            </Field>
          </>
        ) : null}

        {status ? <p className="text-caption text-fg-tertiary">{status}</p> : null}
        {error ? <p className="text-caption text-error">{error}</p> : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={ghostBtn}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || showNew || !connectionId || !remotePath.trim()}
            className={primaryBtn}
          >
            Add folder
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const inputClass = cn(
  'h-9 w-full rounded-md bg-surface-2 border border-subtle px-3',
  'text-body-sm text-fg-primary placeholder:text-fg-tertiary',
  'focus:outline-none focus:border-accent',
);

const primaryBtn = cn(
  'h-8 px-3 rounded-md text-body-sm font-medium bg-accent text-white',
  'transition-opacity duration-fast hover:opacity-90',
  'disabled:opacity-50 disabled:cursor-not-allowed',
);

const ghostBtn = cn(
  'h-8 px-3 rounded-md text-body-sm text-fg-secondary shrink-0',
  'hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast',
);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption text-fg-tertiary">{label}</span>
      {children}
    </label>
  );
}
