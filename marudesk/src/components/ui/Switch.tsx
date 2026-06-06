import { cn } from '../../lib/cn';

export type SwitchProps = {
  /** Whether the switch is on. Controlled — the parent owns this. */
  checked: boolean;
  /** Called with the next value when the user flips the switch. */
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible label (no visible text label is rendered). */
  label?: string;
  className?: string;
};

/**
 * A small accent-tinted on/off switch — the enable/disable control shared by the
 * MCP-servers and plugins settings panels. A pill track with a sliding white
 * knob; `role="switch"` + `aria-checked` keep it accessible to screen readers
 * and keyboards. Controlled: the parent holds `checked` and applies the change.
 */
export function Switch({ checked, onChange, disabled, label, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-pill px-0.5',
        'outline-none transition-colors duration-fast',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-surface-3',
        className,
      )}
    >
      <span
        className={cn(
          'size-3.5 rounded-full bg-white shadow-sm transition-transform duration-fast',
          checked ? 'translate-x-[18px]' : 'translate-x-0',
        )}
      />
    </button>
  );
}
