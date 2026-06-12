import { Check, ShieldCheck, X } from 'lucide-react';
import type { PendingApproval } from '../types';
import { DiffText, proposedDiffText } from './DiffText';

/**
 * Inline approval gate for a tool the agent wants to run (e.g. eval_js, navigate).
 * Anchored above the composer; large approve/deny tap targets.
 *
 * SECURITY NOTE (design §6): whether a phone may self-approve gated tools — vs.
 * forcing approval at the PC UI — is a B-stage policy decision. This UI assumes
 * remote approval is allowed; if the PC pins approvals locally, the host simply
 * won't surface `pendingApproval` to the phone and this never renders.
 */
export function ApprovalPrompt({
  approval,
  busy,
  onDecision,
}: {
  approval: PendingApproval;
  busy: boolean;
  onDecision: (approved: boolean) => void;
}) {
  const isEdit = !!approval.diffs && approval.diffs.length > 0;
  return (
    <div className="approval-panel">
      <div className="approval-panel__header">
        <ShieldCheck size={18} className="approval-panel__icon" />
        <strong>{isEdit ? 'Review change' : 'Approve tool'}</strong>
        <code>{approval.name}</code>
      </div>
      {isEdit ? (
        // The proposed change, shown ABOVE the approve/deny buttons so the user
        // reviews exactly what will be written before anything touches disk.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
          {approval.diffs!.map((d, i) => (
            <div key={`${d.path}-${i}`}>
              <code style={{ fontSize: 12, opacity: 0.7 }}>{d.path}</code>
              <DiffText text={proposedDiffText(d.before, d.after)} />
            </div>
          ))}
        </div>
      ) : (
        <pre className="approval-panel__detail">{approval.detail}</pre>
      )}
      <div className="approval-panel__actions">
        <button className="btn btn-danger" style={{ flex: 1 }} disabled={busy} onClick={() => onDecision(false)}>
          <X size={18} /> Deny
        </button>
        <button className="btn btn-primary" style={{ flex: 1 }} disabled={busy} onClick={() => onDecision(true)}>
          <Check size={18} /> {isEdit ? 'Apply' : 'Approve'}
        </button>
      </div>
    </div>
  );
}
