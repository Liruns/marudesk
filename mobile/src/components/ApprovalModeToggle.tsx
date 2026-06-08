import { Eye, Hand, NotebookPen, Zap, type LucideIcon } from 'lucide-react';
import type { AgentApprovalMode } from '../types';
import { useAppStore } from '../store/useAppStore';

/**
 * U10 mobile parity: flip the PC's approval mode from the phone, mirroring the
 * desktop composer toggle. The host owns + persists the mode (a setting); it's
 * projected into the chat snapshot as `chat.approvalMode`, so this highlights the
 * live value and `set-approval-mode` changes it (applies on the next turn). A
 * compact icon row anchored above the composer.
 */
const MODES: { value: AgentApprovalMode; icon: LucideIcon; label: string }[] = [
  { value: 'plan', icon: NotebookPen, label: 'Plan' },
  { value: 'read-only', icon: Eye, label: 'Read-only' },
  { value: 'ask', icon: Hand, label: 'Ask' },
  { value: 'auto', icon: Zap, label: 'Auto' },
];

export function ApprovalModeToggle({ disabled }: { disabled?: boolean }) {
  const mode = useAppStore((s) => s.chat.approvalMode);
  const setApprovalMode = useAppStore((s) => s.setApprovalMode);
  return (
    <div
      role="group"
      aria-label="Approval mode"
      className="approval-mode-toggle"
      style={{ display: 'flex', alignItems: 'center', gap: 4 }}
    >
      {MODES.map((opt) => {
        const Icon = opt.icon;
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            aria-label={opt.label}
            title={opt.label}
            onClick={() => void setApprovalMode(opt.value)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              borderRadius: 8,
              border: '1px solid',
              borderColor: active ? 'var(--accent, #6aa3ff)' : 'transparent',
              background: active ? 'color-mix(in srgb, var(--accent, #6aa3ff) 18%, transparent)' : 'transparent',
              color: active ? 'var(--accent, #6aa3ff)' : 'inherit',
              opacity: disabled ? 0.5 : active ? 1 : 0.6,
              cursor: disabled ? 'default' : 'pointer',
              fontSize: 12,
              lineHeight: 1,
            }}
          >
            <Icon size={13} />
            {active ? <span>{opt.label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
