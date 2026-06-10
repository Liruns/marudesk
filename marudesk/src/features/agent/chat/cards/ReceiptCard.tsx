import { useState } from 'react';
import { Camera, Check, RotateCcw } from 'lucide-react';
import { Badge } from '../../../../components/ui';
import { useI18n } from '../../../../i18n/useI18n';
import { toast } from '../../../../lib/toast';
import { useAgentStore } from '../../store';
import { formatRuntimeChecks, type Receipt } from '../format';

/* ── completion receipt (Antigravity "Walkthrough" parity) ──────────────── */

export function ReceiptCard({
  receipt,
  turnId,
}: {
  receipt: Receipt;
  turnId: string | null;
}) {
  const { locale, t } = useI18n();
  const restoreCheckpoint = useAgentStore((s) => s.restoreCheckpoint);
  // Running-app snapshot (benchmark Top8): captured on demand so a base64 image
  // never enters the agent snapshot / session persistence. null = not captured;
  // '' = captured but no web view to grab.
  const [shot, setShot] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const capture = async () => {
    setShooting(true);
    try {
      const res = await window.marudesk.invoke('browser:capture-page-data');
      setShot(res ? res.dataUrl : '');
    } catch {
      setShot('');
    } finally {
      setShooting(false);
    }
  };
  // Roll the whole working tree back to this turn's start (§3.6). Confirmed
  // because it reverts every change since the turn (current work is parked on the
  // git stash stack first, so it's recoverable).
  const restore = async () => {
    if (!turnId || restoring) return;
    if (!window.confirm(t('agent.chat.receipt.restoreConfirm'))) return;
    setRestoring(true);
    try {
      const res = await restoreCheckpoint(turnId);
      if (res.ok) {
        toast({
          title: t('agent.chat.receipt.restoreOk'),
          description: res.stashedCurrent ? t('agent.chat.receipt.restoreStashed') : undefined,
          variant: 'success',
        });
      } else {
        toast({
          title: t('agent.chat.receipt.restoreFailed'),
          description: t(
            res.reason === 'none'
              ? 'agent.chat.receipt.restoreNone'
              : res.reason === 'no-repo'
                ? 'agent.chat.receipt.restoreNoRepo'
                : 'agent.chat.receipt.restoreApplyFailed',
          ),
          variant: 'error',
        });
      }
    } finally {
      setRestoring(false);
    }
  };
  return (
    <div className="rounded-xl border border-subtle/80 bg-surface-1/80 p-3 flex flex-col gap-2 shadow-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex items-center gap-2 text-body-sm text-fg-primary">
          <span className="flex size-5 items-center justify-center rounded-pill bg-success-subtle shrink-0">
            <Check size={12} className="text-success" />
          </span>
          <span className="font-medium">{t('agent.chat.status.done')}</span>
        </span>
        {receipt.verdict ? (
          <Badge variant={receipt.verdict.variant}>{t(receipt.verdict.labelKey)}</Badge>
        ) : null}
        {receipt.runtime > 0 ? (
          <span className="flex items-center gap-1 text-caption text-fg-tertiary tabular-nums">
            <span className="size-1.5 rounded-pill bg-accent shrink-0" aria-hidden />
            {formatRuntimeChecks(locale, receipt.runtime)}
          </span>
        ) : null}
        <span className="flex-1" aria-hidden />
        {turnId ? (
          <button
            type="button"
            onClick={() => void restore()}
            disabled={restoring}
            title={t('agent.chat.receipt.restoreTitle')}
            className="flex items-center gap-1 text-caption text-fg-tertiary hover:text-error transition-colors duration-fast disabled:opacity-50"
          >
            <RotateCcw size={12} /> {t('agent.chat.receipt.restore')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void capture()}
          disabled={shooting}
          title={t('agent.chat.receipt.snapshotTitle')}
          className="flex items-center gap-1 text-caption text-fg-tertiary hover:text-accent transition-colors duration-fast disabled:opacity-50"
        >
          <Camera size={12} /> {t('agent.chat.receipt.snapshot')}
        </button>
      </div>
      {shot ? (
        <img
          src={shot}
          alt={t('agent.chat.receipt.snapshotAlt')}
          className="w-full rounded border border-subtle"
        />
      ) : shot === '' ? (
        <span className="text-caption text-fg-tertiary">
          {t('agent.chat.receipt.snapshotNone')}
        </span>
      ) : null}
    </div>
  );
}
