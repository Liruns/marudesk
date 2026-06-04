import { Check, ShieldCheck, X } from 'lucide-react';
import type { PendingApproval } from '../types';

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
  return (
    <div className="approval-panel">
      <div className="approval-panel__header">
        <ShieldCheck size={18} className="approval-panel__icon" />
        <strong>Approve tool</strong>
        <code>
          {approval.name}
        </code>
      </div>
      <pre className="approval-panel__detail">
        {approval.detail}
      </pre>
      <div className="approval-panel__actions">
        <button className="btn btn-danger" style={{ flex: 1 }} disabled={busy} onClick={() => onDecision(false)}>
          <X size={18} /> Deny
        </button>
        <button className="btn btn-primary" style={{ flex: 1 }} disabled={busy} onClick={() => onDecision(true)}>
          <Check size={18} /> Approve
        </button>
      </div>
    </div>
  );
}
