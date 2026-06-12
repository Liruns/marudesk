import { cn } from '../../../lib/cn';
import { useI18n } from '../../../i18n/useI18n';
import type { NetworkEntry } from '../types';
import { fmtBytes, fmtMs, summarize } from './network-utils';

/**
 * Presentational pieces of the Network panel's request table: the per-row
 * waterfall mini-bar and the bottom summary bar. The request detail pane (the
 * tabbed Headers/Payload/Response/Timing/Frames view) lives in NetworkDetail.tsx.
 */

export function Waterfall({
  entry,
  wf,
}: {
  entry: NetworkEntry;
  wf: { min: number; span: number } | null;
}) {
  if (!wf) return null;
  const start = entry.startTime;
  const end = entry.endTime ?? start;
  const left = ((start - wf.min) / wf.span) * 100;
  const width = Math.max(((end - start) / wf.span) * 100, 0.5);
  return (
    <div className="relative h-2 w-full" aria-hidden>
      <div
        className={cn(
          'absolute top-0 h-full rounded-sm',
          entry.failed ? 'bg-error/60' : entry.endTime === undefined ? 'bg-accent/40' : 'bg-accent/60',
        )}
        style={{ left: `${Math.min(left, 100)}%`, width: `${Math.min(width, 100)}%` }}
      />
    </div>
  );
}

/** The bottom status bar: request count, transferred bytes, and page timing. */
export function SummaryBar({
  summary,
}: {
  summary: ReturnType<typeof summarize>;
}) {
  const { t } = useI18n();
  return (
    <div className="shrink-0 h-6 flex items-center gap-3 px-2 border-t border-subtle text-caption text-fg-tertiary tabular-nums whitespace-nowrap overflow-hidden">
      <span>
        <span className="text-fg-secondary">{summary.count}</span> {t('devtools.network.requests')}
      </span>
      <span>
        <span className="text-fg-secondary">{fmtBytes(summary.transferred)}</span> {t('devtools.network.transferred')}
      </span>
      {summary.finish !== null ? (
        <span>
          {t('devtools.network.finish')} <span className="text-fg-secondary">{fmtMs(summary.finish)}</span>
        </span>
      ) : null}
      {summary.dcl !== null ? (
        <span>
          DOMContentLoaded <span className="text-fg-secondary">{fmtMs(summary.dcl)}</span>
        </span>
      ) : null}
      {summary.loaded !== null ? (
        <span>
          {t('devtools.network.load')} <span className="text-fg-secondary">{fmtMs(summary.loaded)}</span>
        </span>
      ) : null}
    </div>
  );
}
