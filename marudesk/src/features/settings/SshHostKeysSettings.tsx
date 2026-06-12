import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import type { SshPinnedHostKey } from '../../../shared/ssh';
import { useI18n } from '../../i18n/useI18n';
import { Section } from './SettingsControls';

/**
 * Pinned SSH host keys (trust-on-first-use). The first connect to an SSH host
 * pins its key fingerprint; a later mismatch REJECTS the connection (MITM
 * defense). This list is the escape hatch for the legitimate case — a host that
 * was reinstalled: remove its pin here, and the next connect re-pins the new
 * key. Lives in Settings → Remote alongside the other remote-access surfaces.
 */
export function SshHostKeysSettings() {
  const { t } = useI18n();
  const [keys, setKeys] = useState<SshPinnedHostKey[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setKeys(await window.marudesk.invoke('ssh:list-host-keys'));
    } catch {
      setKeys([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = useCallback(
    async (entry: SshPinnedHostKey) => {
      if (
        !window.confirm(
          `${t('settings.sshHostKeys.clearConfirmBefore')}${entry.host}:${entry.port}${t('settings.sshHostKeys.clearConfirmAfter')}`,
        )
      ) {
        return;
      }
      setBusy(true);
      try {
        await window.marudesk.invoke('ssh:clear-host-key', {
          host: entry.host,
          port: entry.port,
        });
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh, t],
  );

  return (
    <Section>
      <div className="flex flex-col gap-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <KeyRound size={15} className="text-fg-tertiary" />
          <span className="text-body-sm font-medium text-fg-primary">
            {t('settings.sshHostKeys.title')}
          </span>
        </div>
        <p className="text-caption text-fg-tertiary">{t('settings.sshHostKeys.hint')}</p>

        {keys.length === 0 ? (
          <p className="text-body-sm text-fg-tertiary">{t('settings.sshHostKeys.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {keys.map((entry) => (
              <li
                key={`${entry.host}:${entry.port}`}
                className="flex items-center gap-2 rounded border border-subtle bg-surface-1 px-2 py-1.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm text-fg-primary">
                    {entry.host}:{entry.port}
                  </span>
                  <span className="block truncate font-mono text-caption text-fg-tertiary">
                    {entry.algorithm} {entry.fingerprintSha256}
                  </span>
                </span>
                {entry.pinnedAt > 0 ? (
                  <span className="shrink-0 text-caption text-fg-tertiary tabular-nums">
                    {new Date(entry.pinnedAt).toLocaleDateString()}
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(entry)}
                  title={t('settings.sshHostKeys.clear')}
                  aria-label={t('settings.sshHostKeys.clear')}
                  className="shrink-0 p-1 text-fg-tertiary hover:text-error transition-colors duration-fast"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
