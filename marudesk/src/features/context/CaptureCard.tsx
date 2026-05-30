import { useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { Badge } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useWebPageStore } from '../browser/store';
import { useWorkspaceStore } from '../workspace/store';
import type { Capture } from '../../../shared/capture';

export function CaptureCard({ capture }: { capture: Capture }) {
  const removeCapture = useWebPageStore((s) => s.removeCapture);
  const selected = useWebPageStore((s) =>
    s.selectedCaptureIds.has(capture.id),
  );
  const toggleSelected = useWebPageStore((s) => s.toggleCaptureSelected);
  const summary = useWorkspaceStore((s) => s.summary);
  const ranking = useWorkspaceStore((s) => s.ranking[capture.id]);
  const pending = useWorkspaceStore((s) => s.rankingPending[capture.id]);
  const error = useWorkspaceStore((s) => s.rankingError[capture.id]);
  const rankCapture = useWorkspaceStore((s) => s.rankCapture);
  const [expanded, setExpanded] = useState(false);

  const onToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && summary && ranking === undefined && !pending) {
      void rankCapture(capture);
    }
  };

  return (
    <article
      className={cn(
        'rounded border bg-surface-2 flex flex-col transition-colors duration-fast',
        selected ? 'border-default' : 'border-subtle opacity-70',
      )}
    >
      <div className="p-3 flex flex-col gap-2">
        <header className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => toggleSelected(capture.id)}
            aria-label={selected ? 'Deselect capture' : 'Select capture'}
            className="mt-0.5 size-3.5 accent-accent shrink-0"
          />
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="flex items-center gap-2 min-w-0 text-left flex-1 group"
          >
            <span className="text-fg-tertiary group-hover:text-fg-secondary transition-colors duration-fast shrink-0">
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
            <Badge variant="accent">{capture.tagName}</Badge>
            <span className="text-caption text-fg-tertiary tabular-nums shrink-0">
              {Math.round(capture.rect.width)}×{Math.round(capture.rect.height)}
            </span>
          </button>
          <button
            type="button"
            onClick={() => removeCapture(capture.id)}
            aria-label="Remove capture"
            className="text-fg-tertiary hover:text-fg-primary transition-colors duration-fast shrink-0"
          >
            <X size={14} />
          </button>
        </header>
        <div className="font-mono text-caption text-fg-secondary break-all">
          {capture.selector || '(no selector)'}
        </div>
        {capture.text ? (
          <div className="text-body-sm text-fg-secondary line-clamp-2">
            {capture.text}
          </div>
        ) : null}
      </div>

      {expanded ? (
        <div className="border-t border-subtle px-3 py-2 flex flex-col gap-1.5">
          <div className="text-caption text-fg-tertiary uppercase tracking-wide">
            Related source
          </div>
          {!summary ? (
            <div className="text-caption text-fg-tertiary">
              Open a workspace to rank source files.
            </div>
          ) : pending ? (
            <div className="text-caption text-fg-tertiary">Ranking…</div>
          ) : error ? (
            <div className="text-caption text-fg-tertiary break-all">
              Error: {error}
            </div>
          ) : ranking === undefined ? null : ranking.length === 0 ? (
            <div className="text-caption text-fg-tertiary">
              No matches in workspace.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {ranking.slice(0, 5).map((f) => (
                <li
                  key={f.path}
                  className="flex items-center justify-between gap-2"
                >
                  <span
                    className="font-mono text-caption text-fg-secondary truncate"
                    title={f.path}
                  >
                    {f.path}
                  </span>
                  <span className="text-caption text-fg-tertiary tabular-nums shrink-0">
                    {f.score}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </article>
  );
}
