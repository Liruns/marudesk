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
    <div
      className="card"
      style={{
        margin: '0 12px 10px',
        padding: 14,
        borderColor: 'var(--warn)',
        background: 'rgba(224,166,74,0.08)',
      }}
    >
      <div className="label-row" style={{ marginBottom: 8 }}>
        <ShieldCheck size={18} style={{ color: 'var(--warn)' }} />
        <strong style={{ fontSize: 15 }}>Approve tool</strong>
        <code style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--warn)', fontWeight: 700 }}>
          {approval.name}
        </code>
      </div>
      <pre
        style={{
          margin: '0 0 12px',
          padding: 10,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 13,
          lineHeight: 1.45,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: 'var(--fg)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 160,
          overflowY: 'auto',
        }}
      >
        {approval.detail}
      </pre>
      <div style={{ display: 'flex', gap: 10 }}>
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
