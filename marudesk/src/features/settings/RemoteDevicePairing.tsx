import { useCallback, useEffect, useState } from 'react';
import { QrCode, RefreshCw } from 'lucide-react';
import type {
  PairedDeviceInfo,
  PairingRequestInfo,
  PairingStartInfo,
} from '../../../shared/remote';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { Section } from './SettingsControls';
import { ApprovalCard, DeviceRow, QrCard } from './RemotePairingCards';

export function DevicePairing() {
  const { t } = useI18n();
  const [devices, setDevices] = useState<PairedDeviceInfo[]>([]);
  const [pending, setPending] = useState<PairingRequestInfo[]>([]);
  const [start, setStart] = useState<PairingStartInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void window.marudesk
      .invoke('server:list-devices')
      .then(setDevices)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    return window.marudesk.on('server:pairing-request', (info) =>
      setPending((requests) => [
        ...requests.filter((request) => request.approvalId !== info.approvalId),
        info,
      ]),
    );
  }, [refresh]);

  const beginPair = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setStart(await window.marudesk.invoke('server:pairing-start'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approvalId: string, approved: boolean): Promise<void> => {
    setPending((requests) =>
      requests.filter((request) => request.approvalId !== approvalId),
    );
    try {
      await window.marudesk.invoke(
        approved ? 'server:pairing-approve' : 'server:pairing-reject',
        { approvalId },
      );
    } catch {
      return;
    }
    if (approved) {
      setStart(null);
      refresh();
    }
  };

  const revoke = async (device: PairedDeviceInfo): Promise<void> => {
    const confirmed = window.confirm(
      `${t('settings.remote.pairing.revokeConfirmBefore')}${device.name}${t(
        'settings.remote.pairing.revokeConfirmAfter',
      )}`,
    );
    if (!confirmed) return;
    try {
      setDevices(
        await window.marudesk.invoke('server:revoke-device', {
          deviceId: device.deviceId,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-body font-medium text-fg-primary">
            {t('settings.remote.pairing.title')}
          </h3>
          <p className="text-caption text-fg-tertiary">
            {t('settings.remote.pairing.description')}
          </p>
        </div>
        {devices.length > 0 ? (
          <button
            type="button"
            aria-label={t('settings.remote.pairing.refreshDevices')}
            onClick={refresh}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary transition-colors duration-fast"
          >
            <RefreshCw size={14} />
          </button>
        ) : null}
      </header>

      {pending.map((request) => (
        <ApprovalCard
          key={request.approvalId}
          req={request}
          onDecide={decide}
        />
      ))}

      {start ? (
        <QrCard start={start} onClose={() => setStart(null)} />
      ) : (
        <Button
          variant="secondary"
          disabled={busy}
          leadingIcon={<QrCode size={15} />}
          onClick={() => void beginPair()}
        >
          {t('settings.remote.pairing.pairDevice')}
        </Button>
      )}
      {error ? <span className="text-caption text-error">{error}</span> : null}

      {devices.length > 0 ? (
        <Section>
          {devices.map((device) => (
            <DeviceRow
              key={device.deviceId}
              device={device}
              onRevoke={() => void revoke(device)}
            />
          ))}
        </Section>
      ) : null}
    </div>
  );
}
