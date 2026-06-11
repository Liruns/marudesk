import { Check, FlaskConical } from 'lucide-react';
import { BottomSheet } from '../../components/BottomSheet';
import { useAppStore } from '../../store/useAppStore';
import type { ReasoningEffort } from '../../types';

const EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: 'minimal', label: 'Min' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
];

/**
 * Per-chat model + reasoning picker, fed by the PC's connected providers
 * (`GET /agent/models`) — the phone twin of the desktop's model palette and
 * reasoning dial. Disconnected providers are listed but not selectable (connect
 * them on the PC); reasoning effort is a PC setting that applies on the next
 * turn, mirrored back through the chat snapshot.
 */
export function ModelSheet({ onClose }: { readonly onClose: () => void }) {
  const providers = useAppStore((s) => s.providers);
  const provider = useAppStore((s) => s.provider);
  const model = useAppStore((s) => s.model);
  const effort = useAppStore((s) => s.chat.reasoningEffort);
  const selectModel = useAppStore((s) => s.selectModel);
  const setReasoningEffort = useAppStore((s) => s.setReasoningEffort);

  // Connected providers first, like the desktop picker; experimental tagged.
  const ordered = [...providers].sort((a, b) => Number(b.connected) - Number(a.connected));

  return (
    <BottomSheet title="Model & reasoning" onClose={onClose}>
      <div className="effort-row" role="group" aria-label="Reasoning effort">
        <span className="effort-row__label">Reasoning</span>
        <div className="effort-row__options">
          {EFFORTS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`effort-pill${effort === opt.value ? ' effort-pill--active' : ''}`}
              aria-pressed={effort === opt.value}
              onClick={() => void setReasoningEffort(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      {ordered.map((p) => (
        <div key={p.id} className="model-group">
          <div className="model-group__header">
            <span className="model-group__name">{p.label}</span>
            {p.experimental && <FlaskConical size={12} className="model-group__flag" />}
            {!p.connected && <span className="model-group__off">not connected</span>}
          </div>
          {p.connected &&
            p.models.map((m) => {
              const active = provider === p.id && model === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`picker-row${active ? ' picker-row--active' : ''}`}
                  onClick={() => {
                    void selectModel(p.id, m.id);
                    onClose();
                  }}
                >
                  <span className="picker-row__label">{m.label}</span>
                  {active && <Check size={16} className="picker-row__check" />}
                </button>
              );
            })}
        </div>
      ))}
      {ordered.length === 0 && <div className="picker-empty">No provider catalog from the PC.</div>}
    </BottomSheet>
  );
}
