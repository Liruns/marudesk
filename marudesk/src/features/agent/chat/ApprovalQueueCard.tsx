import { AlertCircle } from 'lucide-react';
import type { ApprovalQueueItem } from '../../../../shared/agent-orchestration';
import { Button, DiffBlock } from '../../../components/ui';
import { useI18n } from '../../../i18n/useI18n';
import { useAgentStore } from '../store';
import { toDiffLines } from '../diff';

export function ApprovalQueueCard({
  approvals,
}: {
  readonly approvals: readonly ApprovalQueueItem[];
}) {
  const { t } = useI18n();
  const approveForTurn = useAgentStore((s) => s.approveForTurn);
  if (approvals.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 rounded border border-warning/40 bg-warning-subtle/30 p-2.5">
      <div className="flex items-center gap-2 text-caption uppercase tracking-wider text-fg-tertiary">
        <AlertCircle size={13} className="shrink-0 text-warning" />
        <span>Approvals</span>
        <span className="ml-auto tabular-nums">{approvals.length}</span>
      </div>
      {approvals.map((approval) => (
        <ApprovalQueueItemRow
          key={`${approval.turnId}:${approval.callId}`}
          approval={approval}
          onApprove={(approved, always) =>
            approveForTurn(approval.turnId, approval.callId, approved, always)
          }
          labels={{
            approve: t('agent.chat.approve'),
            allowAlways: t('agent.chat.allowAlways'),
            deny: t('agent.chat.deny'),
            apply: t('agent.chat.apply'),
          }}
        />
      ))}
    </div>
  );
}

function ApprovalQueueItemRow({
  approval,
  onApprove,
  labels,
}: {
  readonly approval: ApprovalQueueItem;
  readonly onApprove: (approved: boolean, always?: boolean) => Promise<void>;
  readonly labels: {
    readonly approve: string;
    readonly allowAlways: string;
    readonly deny: string;
    readonly apply: string;
  };
}) {
  const isEdit = !!approval.diffs && approval.diffs.length > 0;
  return (
    <div className="rounded border border-warning/30 bg-surface-1/80 p-2">
      <div className="mb-2 flex items-start gap-2 text-body-sm text-fg-primary">
        <span className="min-w-0 flex-1">
          <span className="font-mono break-all">{approval.name}</span>
          <span className="ml-2 text-caption text-fg-tertiary">
            {approval.threadTitle}
            {approval.activeThread ? ' · active' : ''}
          </span>
        </span>
      </div>
      {approval.diffs && approval.diffs.length > 0 ? (
        <div className="mb-2 flex max-h-64 flex-col gap-1.5 overflow-y-auto">
          {approval.diffs.map((d, i) => (
            <DiffBlock
              key={`${d.path}-${i}`}
              filePath={d.path}
              lines={toDiffLines(d.before || null, d.after)}
            />
          ))}
        </div>
      ) : (
        <pre className="mb-2 max-h-32 overflow-y-auto rounded bg-surface-page px-2 py-1.5 font-mono text-caption text-fg-secondary whitespace-pre-wrap break-words">
          {approval.detail}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => void onApprove(true)}>
          {isEdit ? labels.apply : labels.approve}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void onApprove(true, true)}>
          {labels.allowAlways}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void onApprove(false)}>
          {labels.deny}
        </Button>
      </div>
    </div>
  );
}
