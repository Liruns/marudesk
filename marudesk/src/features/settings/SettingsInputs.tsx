import { useState } from 'react';
import { cn } from '../../lib/cn';
import { STEP_BTN } from './settingsControlStyles';

export function Segmented<T extends string>({
  value,
  options,
  ariaLabel,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  ariaLabel?: string;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-md bg-surface-2 p-0.5 gap-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'px-3 h-7 rounded text-body-sm transition-colors duration-fast',
            value === o.value
              ? 'bg-surface-page text-fg-primary'
              : 'text-fg-tertiary hover:text-fg-secondary',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper({
  value,
  min,
  max,
  step,
  suffix,
  name,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  name: string;
  onChange: (value: number) => void;
}) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  return (
    <div className="inline-flex items-center gap-1 rounded-md bg-surface-2 p-0.5">
      <button
        type="button"
        aria-label={`Decrease ${name}`}
        disabled={value <= min}
        onClick={() => set(value - step)}
        className={STEP_BTN}
      >
        <Minus />
      </button>
      <span className="min-w-[56px] text-center text-body-sm text-fg-primary tabular-nums">
        {value}
        {suffix}
      </span>
      <button
        type="button"
        aria-label={`Increase ${name}`}
        disabled={value >= max}
        onClick={() => set(value + step)}
        className={STEP_BTN}
      >
        <Plus />
      </button>
    </div>
  );
}

export function TextField({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [local, setLocal] = useState(value);
  const [committed, setCommitted] = useState(value);
  if (value !== committed) {
    setCommitted(value);
    setLocal(value);
  }
  const commit = () => {
    if (local !== value) onCommit(local);
  };
  return (
    <input
      type="text"
      value={local}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setLocal(value);
          e.currentTarget.blur();
        }
      }}
      className={cn(
        'h-8 w-[240px] max-w-[40vw] rounded-md bg-surface-page border border-default px-3',
        'text-body-sm text-fg-primary placeholder:text-fg-tertiary',
        'focus:outline-none focus:border-accent transition-colors duration-fast',
      )}
    />
  );
}

function Minus() {
  return <span aria-hidden className="block h-px w-2.5 bg-current" />;
}

function Plus() {
  return (
    <span aria-hidden className="relative block size-2.5">
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-current" />
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-current" />
    </span>
  );
}
