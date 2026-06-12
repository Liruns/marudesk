import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, Smartphone, Trash2, X } from 'lucide-react';
import QRCode from 'qrcode';
import type {
  PairedDeviceInfo,
  PairingRequestInfo,
  PairingStartInfo,
} from '../../../shared/remote';
import { Button } from '../../components/ui';
import { useCountdown } from '../../hooks';
import { useI18n, type I18nContextValue } from '../../i18n/useI18n';
import { Section } from './SettingsControls';

export function QrCard({
  start,
  onClose,
}: {
  readonly start: PairingStartInfo;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remaining = useCountdown(start.expiresAt);
  const expired = remaining <= 0;

  useEffect(() => {
    let alive = true;
    void QRCode.toDataURL(start.qr, {
      width: 240,
      margin: 1,
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (alive) setDataUrl(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [start.qr]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // The full QR payload IS the manual-entry pairing code — the phone's paste
  // box needs all of it (PC public key + addresses), not the short check code.
  const copyPairingCode = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(start.qr);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused — leave the button as-is; the QR remains scannable.
    }
  };

  return (
    <Section>
      <div className="flex flex-col items-center gap-3 px-4 py-5">
        <div className="flex w-full items-center justify-between">
          <span className="text-body-sm text-fg-primary">
            {t('settings.remote.pairing.scan')}
          </span>
          <button
            type="button"
            aria-label={t('settings.remote.pairing.close')}
            onClick={onClose}
            className="inline-flex size-7 items-center justify-center rounded text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary transition-colors duration-fast"
          >
            <X size={15} />
          </button>
        </div>
        {expired ? (
          <div className="flex h-[240px] w-[240px] items-center justify-center rounded-lg bg-surface-2 px-6 text-center text-caption text-fg-tertiary">
            {t('settings.remote.pairing.expired')}
          </div>
        ) : dataUrl ? (
          <img
            src={dataUrl}
            width={240}
            height={240}
            alt={t('settings.remote.pairing.qrAlt')}
            className="rounded-lg bg-white p-2"
          />
        ) : (
          <div className="flex h-[240px] w-[240px] items-center justify-center">
            <Loader2 size={22} className="animate-spin text-fg-tertiary" />
          </div>
        )}
        <div className="flex flex-col items-center gap-2">
          {!expired ? (
            <>
              <span className="text-caption text-fg-tertiary">
                {t('settings.remote.pairing.copyHint')}
              </span>
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={copied ? <Check size={14} /> : <Copy size={14} />}
                onClick={() => void copyPairingCode()}
              >
                {copied
                  ? t('settings.remote.pairing.copied')
                  : t('settings.remote.pairing.copy')}
              </Button>
              <span className="text-caption text-fg-tertiary">
                {t('settings.remote.pairing.expiresBefore')}
                {remaining}
                {t('settings.remote.pairing.expiresAfter')}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

export function ApprovalCard({
  req,
  onDecide,
}: {
  readonly req: PairingRequestInfo;
  readonly onDecide: (approvalId: string, approved: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-subtle bg-accent-subtle px-4 py-3">
      <div className="flex items-center gap-2.5">
        <Smartphone size={18} className="shrink-0 text-accent" aria-hidden />
        <div className="flex min-w-0 flex-col">
          <span className="text-body-sm text-fg-primary">
            {t('settings.remote.pairing.approveBefore')}
            {req.name}
            {t('settings.remote.pairing.approveAfter')}
          </span>
          <span className="text-caption text-fg-tertiary">
            {t('settings.remote.pairing.fingerprint')}{' '}
            <span className="font-mono">{req.fingerprint}</span>
            {t('settings.remote.pairing.fingerprintHint')}
          </span>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => onDecide(req.approvalId, true)}
        >
          {t('settings.remote.pairing.approve')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onDecide(req.approvalId, false)}
        >
          {t('settings.remote.pairing.reject')}
        </Button>
      </div>
    </div>
  );
}

export function DeviceRow({
  device,
  onRevoke,
}: {
  readonly device: PairedDeviceInfo;
  readonly onRevoke: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Smartphone size={16} className="shrink-0 text-fg-tertiary" aria-hidden />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-body-sm text-fg-primary">{device.name}</span>
          <span className="text-caption text-fg-tertiary">
            <span className="font-mono">{device.fingerprint}</span> ·{' '}
            {device.lastSeenAt
              ? `${t('settings.remote.pairing.lastSeen')} ${relativeTime(
                  device.lastSeenAt,
                  t,
                )}`
              : t('settings.remote.pairing.notConnected')}
          </span>
        </div>
      </div>
      <button
        type="button"
        aria-label={`${t('settings.remote.pairing.revoke')} ${device.name}`}
        onClick={onRevoke}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded text-fg-tertiary hover:bg-surface-2 hover:text-error transition-colors duration-fast"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function relativeTime(iso: string, t: I18nContextValue['t']): string {
  const diffMs = Date.now() - Date.parse(iso);
  const min = Math.floor(diffMs / 60_000);
  if (!Number.isFinite(min) || min < 1) return t('settings.remote.pairing.justNow');
  if (min < 60) return `${min}${t('settings.remote.pairing.minutesAgo')}`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}${t('settings.remote.pairing.hoursAgo')}`;
  return `${Math.floor(hour / 24)}${t('settings.remote.pairing.daysAgo')}`;
}
