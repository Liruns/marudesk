import { AlertCircle } from 'lucide-react';
import { Button, DiffBlock } from '../../../../components/ui';
import { useI18n } from '../../../../i18n/useI18n';
import type { PendingApproval } from '../../../../../shared/agent';
import { useAgentStore } from '../../store';
import { toDiffLines } from '../../diff';

/* ── approval (parked turns) ─────────────────────────────────────────────── */

export function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const { t } = useI18n();
  const approve = useAgentStore((s) => s.approve);
  const isEdit = !!approval.diffs && approval.diffs.length > 0;
  return (
    <div className="rounded-lg border border-warning/35 bg-warning-subtle/25 p-3 flex flex-col gap-2.5 shadow-card">
      <div className="flex items-start gap-2 text-body-sm text-fg-primary">
        <AlertCircle size={14} className="mt-0.5 shrink-0 text-warning" />
        <span className="min-w-0">
          {isEdit ? (
            t('agent.chat.reviewEdit')
          ) : (
            <>
              {t('agent.chat.approveBefore')}{' '}
              <span className="font-mono break-all">{approval.name}</span>
              {t('agent.chat.approveAfter')}
            </>
          )}
        </span>
      </div>
      {approval.diffs && approval.diffs.length > 0 ? (
        <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
          {approval.diffs.map((d, i) => (
            <DiffBlock
              key={`${d.path}-${i}`}
              filePath={d.path}
              lines={toDiffLines(d.before || null, d.after)}
            />
          ))}
        </div>
      ) : (
        <pre className="m-0 font-mono text-caption text-fg-secondary whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded bg-surface-page px-2 py-1.5">
          {approval.detail}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => void approve(approval.callId, true)}>
          {isEdit ? t('agent.chat.apply') : t('agent.chat.approve')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void approve(approval.callId, true, true)}
          title={`${t('agent.chat.allowAlwaysBefore')}${approval.name}${t('agent.chat.allowAlwaysAfter')}`}
        >
          {t('agent.chat.allowAlways')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void approve(approval.callId, false)}>
          {t('agent.chat.deny')}
        </Button>
      </div>
    </div>
  );
}
