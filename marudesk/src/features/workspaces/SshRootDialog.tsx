import { KeyRound, Plus, Server, Trash2 } from 'lucide-react';
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
import { useI18n } from '../../i18n/useI18n';
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
  /** Omitted = create a NEW workspace seeded with the chosen SSH folder. */
  workspaceId?: WorkspaceId;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const addSshRoot = useWorkspaceDeckStore((s) => s.addSshRoot);
  const createSshWorkspace = useWorkspaceDeckStore((s) => s.createSshWorkspace);
  const createMode = !workspaceId;

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
  const [homeLoading, setHomeLoading] = useState(false);
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
        setShowNew(false);
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

  const selectConnection = (id: string) => {
    setConnectionId(id);
    setShowNew(false);
    setRemotePath('');
    setError(null);
    setStatus(null);
  };

  /** Forget a saved SSH host (the files on the remote are untouched). */
  const removeSavedConnection = async (id: string) => {
    try {
      await window.marudesk.invoke('ssh:remove-connection', { connectionId: id });
      const list = await window.marudesk.invoke('ssh:list-connections');
      setConnections(list);
      if (connectionId === id) {
        setConnectionId(list[0]?.id ?? null);
        setShowNew(list.length === 0);
      }
    } catch (err) {
      setError(toMessage(err));
    }
  };

  /** Probe + save a new connection, then select it and prefill its home dir. */
  const connectNew = async () => {
    setBusy(true);
    setError(null);
    setStatus(t('ssh.dialog.connecting'));
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
      setStatus(t('ssh.dialog.connectedHome').replace('{dir}', test.homeDir));
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

  useEffect(() => {
    if (!connectionId || showNew) return;
    let active = true;
    const loadHome = async () => {
      setHomeLoading(true);
      setError(null);
      setStatus(null);
      try {
        const res = await window.marudesk.invoke('ssh:list-dir', {
          connectionId,
          path: '.',
        });
        if (!active) return;
        if (res.ok) setRemotePath(res.path);
        else setError(res.reason);
      } catch (err) {
        if (active) setError(toMessage(err));
      } finally {
        if (active) setHomeLoading(false);
      }
    };
    void loadHome();
    return () => {
      active = false;
      setHomeLoading(false);
    };
  }, [connectionId, showNew]);

  const submit = async () => {
    if (!connectionId || !remotePath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const params = {
        connectionId,
        remotePath: remotePath.trim(),
        name: rootName.trim() || undefined,
      };
      const record = workspaceId
        ? await addSshRoot(workspaceId, params)
        : await createSshWorkspace(params);
      if (record) onClose();
      else setError(useWorkspaceDeckStore.getState().error ?? t('ssh.dialog.addFailed'));
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
        aria-label={t(createMode ? 'ssh.dialog.titleCreate' : 'ssh.dialog.titleAdd')}
        onMouseDown={(event) => event.stopPropagation()}
        className="w-[420px] max-h-[88vh] overflow-y-auto rounded-lg bg-surface-1 border border-default shadow-lifted p-4 flex flex-col gap-2 animate-scale-in"
      >
        <h2 className="text-body font-semibold text-fg-primary">
          {t(createMode ? 'ssh.dialog.titleCreate' : 'ssh.dialog.titleAdd')}
        </h2>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-caption font-medium text-fg-secondary uppercase">
              {t('ssh.dialog.connections')}
            </span>
            <button
              type="button"
              aria-label={t('ssh.dialog.addConnection')}
              title={t('ssh.dialog.addConnection')}
              onClick={() => setShowNew(true)}
              className={iconBtn}
            >
              <Plus size={15} />
            </button>
          </div>
          {connections.length > 0 ? (
            <div className="flex flex-col gap-1">
              {connections.map((conn) => {
                const selected = conn.id === connectionId && !showNew;
                return (
                  <div
                    key={conn.id}
                    className={cn(
                      'group w-full min-h-12 rounded-md border flex items-center text-left',
                      'transition-colors duration-fast',
                      selected
                        ? 'border-accent bg-accent-subtle'
                        : 'border-subtle bg-surface-2 hover:border-default hover:bg-surface-3',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => selectConnection(conn.id)}
                      className="min-w-0 flex-1 flex items-center gap-3 px-3 py-2 text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <span className="size-7 shrink-0 rounded-md border border-subtle bg-surface-1 flex items-center justify-center text-fg-tertiary">
                        <Server size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body-sm font-medium text-fg-primary">
                          {conn.label}
                        </span>
                        <span className="block truncate text-caption text-fg-tertiary">
                          {conn.username}@{conn.host}:{conn.port} - {conn.source === 'ssh-config' ? '~/.ssh/config' : t('ssh.dialog.sourceSaved')}
                        </span>
                      </span>
                      <KeyRound size={14} className="shrink-0 text-fg-tertiary" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('ssh.dialog.removeNamed').replace('{name}', conn.label)}
                      title={t('ssh.dialog.removeConnection')}
                      onClick={() => void removeSavedConnection(conn.id)}
                      className="mr-1.5 shrink-0 grid size-7 place-items-center rounded text-fg-tertiary opacity-0 transition-[opacity,colors] duration-fast hover:bg-error-subtle hover:text-error focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="min-h-12 rounded-md border border-subtle bg-surface-2 px-3 py-2 flex items-center justify-between gap-3">
              <span className="text-body-sm text-fg-secondary">{t('ssh.dialog.noConnections')}</span>
              <button
                type="button"
                aria-label={t('ssh.dialog.addConnection')}
                title={t('ssh.dialog.addConnection')}
                onClick={() => setShowNew(true)}
                className={iconBtn}
              >
                <Plus size={15} />
              </button>
            </div>
          )}
        </div>

        {showNew ? (
          <div className="flex flex-col gap-2 rounded-md border border-subtle p-3">
            <div className="flex items-center justify-between">
              <span className="text-caption font-medium text-fg-secondary uppercase">
                {t('ssh.dialog.newConnection')}
              </span>
              {connections.length > 0 ? (
                <button type="button" onClick={() => setShowNew(false)} className={ghostBtn}>
                  {t('ssh.dialog.cancel')}
                </button>
              ) : null}
            </div>
            <Field label={t('ssh.dialog.labelOptional')}>
              <input value={label} onChange={(e) => setLabel(e.currentTarget.value)} className={inputClass} placeholder="my-server" />
            </Field>
            <div className="flex gap-2">
              <div className="flex-1">
                <Field label={t('ssh.dialog.host')}>
                  <input value={host} onChange={(e) => setHost(e.currentTarget.value)} className={inputClass} placeholder="example.com" />
                </Field>
              </div>
              <div className="w-20">
                <Field label={t('ssh.dialog.port')}>
                  <input value={port} onChange={(e) => setPort(e.currentTarget.value)} className={inputClass} inputMode="numeric" />
                </Field>
              </div>
            </div>
            <Field label={t('ssh.dialog.username')}>
              <input value={username} onChange={(e) => setUsername(e.currentTarget.value)} className={inputClass} placeholder="ubuntu" />
            </Field>
            <Field label={t('ssh.dialog.authentication')}>
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
                <option value="agent">{t('ssh.dialog.authAgent')}</option>
                <option value="key">{t('ssh.dialog.authKey')}</option>
                <option value="password">{t('ssh.dialog.password')}</option>
              </select>
            </Field>
            {authMethod === 'key' ? (
              <>
                <Field label={t('ssh.dialog.privateKeyPath')}>
                  <input value={privateKeyPath} onChange={(e) => setPrivateKeyPath(e.currentTarget.value)} className={inputClass} placeholder="~/.ssh/id_ed25519" />
                </Field>
                <Field label={t('ssh.dialog.passphraseOptional')}>
                  <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.currentTarget.value)} className={inputClass} />
                </Field>
              </>
            ) : null}
            {authMethod === 'password' ? (
              <Field label={t('ssh.dialog.password')}>
                <input type="password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} className={inputClass} />
              </Field>
            ) : null}
            <button
              type="button"
              onClick={() => void connectNew()}
              disabled={busy || homeLoading || !newConnectionValid}
              className={primaryBtn}
            >
              {busy ? t('ssh.dialog.connecting') : t('ssh.dialog.connectSave')}
            </button>
          </div>
        ) : null}

        {!showNew && connectionId ? (
          <>
            <Field label={t('ssh.dialog.remotePath')}>
              <div className="flex gap-2">
                <input
                  value={remotePath}
                  onChange={(e) => setRemotePath(e.currentTarget.value)}
                  className={inputClass}
                  placeholder="/home/ubuntu/project"
                />
                <button
                  type="button"
                  onClick={() => void fillHomePath()}
                  disabled={busy || homeLoading}
                  className={ghostBtn}
                >
                  {t('ssh.dialog.home')}
                </button>
              </div>
            </Field>
            <Field label={t('ssh.dialog.rootNameOptional')}>
              <input value={rootName} onChange={(e) => setRootName(e.currentTarget.value)} className={inputClass} placeholder={t('ssh.dialog.rootNamePlaceholder')} />
            </Field>
          </>
        ) : null}

        {status ? <p className="text-caption text-fg-tertiary">{status}</p> : null}
        {error ? <p className="text-caption text-error">{error}</p> : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={ghostBtn}>
            {t('ssh.dialog.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || homeLoading || showNew || !connectionId || !remotePath.trim()}
            className={primaryBtn}
          >
            {t(createMode ? 'ssh.dialog.createWorkspace' : 'ssh.dialog.addFolder')}
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

const iconBtn = cn(
  'size-8 rounded-md flex items-center justify-center text-fg-tertiary shrink-0',
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
