import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { estimateCostUsd, formatCostUsd } from '../../../shared/model-pricing';
import { useComposerStore } from '../composer/store';
import { useContextUsage } from './useContextUsage';
import { formatContext, formatContextWindow, formatUsageTitle } from './chat/format';

/* ── geometry ───────────────────────────────────────────────────────────── */

const SIZE = 12;
const STROKE = 2;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

/** pct → hue token: accent (healthy) → warning (≥80%) → error (≥95%). */
function ringHue(pct: number): string {
  if (pct >= 95) return 'text-error';
  if (pct >= 80) return 'text-warning';
  return 'text-accent';
}

/**
 * Compact context-window ring for the StatusBar — the active conversation's live
 * context occupancy at a glance, without opening the chat. Mirrors the composer's
 * {@link UsageMeter} (same `chat.usage` / `contextWindow` math) but renders a tiny
 * SVG donut instead of a bar, so it reads as a fill gauge in the bottom strip.
 *
 * Hidden until a turn has actually consumed tokens, and — like the meter — tracks
 * `contextTokens` (the last call's input size), so it falls after a compaction
 * instead of climbing forever.
 */
export function ContextRing() {
  const { locale, t } = useI18n();
  const usage = useContextUsage();

  if (!usage) return null;

  const { pct, model } = usage;
  const ctx = model?.contextWindow;
  const cost = model
    ? estimateCostUsd(model.id, usage.inputTokens, usage.outputTokens)
    : null;

  const used = formatContext(usage.contextTokens || usage.inputTokens);
  // Tooltip: "150K/1M (15% used) · 12,345 input - 6,789 output tokens".
  const title = [
    pct !== null
      ? formatContextWindow(locale, `${used}/${formatContext(ctx ?? 0)}`, pct)
      : `${used} tok`,
    formatUsageTitle(
      locale,
      usage.inputTokens.toLocaleString(),
      usage.outputTokens.toLocaleString(),
    ),
  ].join(' · ');

  const reveal = () => useComposerStore.getState().revealChat();

  // No context window (local/unknown model): show a plain token count, no ring.
  if (pct === null) {
    return (
      <button
        type="button"
        onClick={reveal}
        title={title}
        aria-label={t('status.context.aria')}
        className="flex items-center gap-1 tabular-nums hover:text-fg-secondary transition-colors duration-fast"
      >
        {used} tok
      </button>
    );
  }

  const dash = (pct / 100) * C;

  return (
    <button
      type="button"
      onClick={reveal}
      title={title}
      aria-label={t('status.context.aria')}
      className="flex items-center gap-1.5 tabular-nums hover:text-fg-secondary transition-colors duration-fast"
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className={cn('shrink-0 -rotate-90', ringHue(pct))}
        aria-hidden
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          strokeWidth={STROKE}
          className="stroke-surface-3"
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          stroke="currentColor"
          strokeDasharray={`${dash} ${C}`}
        />
      </svg>
      <span className={cn(pct >= 95 && 'text-error', pct >= 80 && pct < 95 && 'text-warning')}>
        {pct}%
      </span>
      {cost !== null ? <span>≈ {formatCostUsd(cost)}</span> : null}
    </button>
  );
}
