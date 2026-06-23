import { cn } from '../../lib/cn';

export type ZoomSliderProps = {
  /** Current scale value in the range [min, max]. */
  value: number;
  min?: number;
  max?: number;
  /** Step size for keyboard arrows. Defaults to 0.05 (5%). */
  step?: number;
  onChange: (next: number) => void;
  /** Accessible name (caller-localized, like Spinner's label). */
  label?: string;
  className?: string;
};

/**
 * A token-styled horizontal zoom slider for the viewport control pill.
 *
 * Track:   bg-surface-3 rail with a bg-accent filled portion driven by a CSS
 *          custom property (`--fill-pct`) so the accent fill tracks the thumb
 *          without a second DOM element — the fill is a linear-gradient on the
 *          track's background that accepts `--accent` on the left and
 *          `--surface-3` on the right, clipped at the current percentage.
 *
 * Thumb:   appearance-none circle, 10px diameter, border-default hairline,
 *          shadow-card lift, hover scale 1.15, active scale 0.95 — subtle
 *          physical feel without any overshoot or bounce.
 *
 * A11y:    native <input type="range"> carries full keyboard semantics (arrows,
 *          Home/End, Page Up/Down) and exposes role="slider" + aria-valuemin /
 *          aria-valuemax / aria-valuenow natively. We add aria-label explicitly.
 *
 * Tokens used: --surface-3, --accent, --border-default, --motion-fast,
 *              --motion-standard, --easing. No literal hex anywhere.
 */
export function ZoomSlider({
  value,
  min = 0.25,
  max = 2.5,
  step = 0.05,
  onChange,
  label = 'Zoom level',
  className,
}: ZoomSliderProps) {
  // Percentage of the way between min and max — drives the track fill gradient.
  const fillPct = (((value - min) / (max - min)) * 100).toFixed(2);

  return (
    <input
      type="range"
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      style={
        {
          // CSS custom property consumed by the ::before pseudo-track gradient
          // injected in index.css. This keeps JSX markup clean and lets the
          // gradient be declared once in the stylesheet.
          '--zoom-fill': `${fillPct}%`,
        } as React.CSSProperties
      }
      className={cn('zoom-slider', className)}
    />
  );
}
