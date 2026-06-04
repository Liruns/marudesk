import { useState } from 'react';
import { ChevronDown, ChevronRight, ClipboardCopy, X } from 'lucide-react';
import { Badge } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { toMessage } from '../../lib/toMessage';
import { useWebPageStore } from '../browser/store';
import { useWorkspaceStore } from '../workspace/store';
import { formatEvidencePack } from '../../../shared/evidence-pack';
import type {
  Capture,
  ConsoleErrorCapture,
  ElementCapture,
} from '../../../shared/capture';

/** Dispatch on the capture kind; each kind renders its own card. */
export function CaptureCard({ capture }: { capture: Capture }) {
  if (capture.kind === 'console-error') {
    return <ConsoleErrorCaptureCard capture={capture} />;
  }
  return <ElementCaptureCard capture={capture} />;
}

/** Shared select/remove header — both cards select into the same composer cart. */
function CardHeader({
  capture,
  children,
}: {
  capture: Capture;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const id = capture.id;
  const removeCapture = useWebPageStore((s) => s.removeCapture);
  const selected = useWebPageStore((s) => s.selectedCaptureIds.has(id));
  const toggleSelected = useWebPageStore((s) => s.toggleCaptureSelected);
  // P1.5: export this capture as a scrubbed Markdown evidence pack to the
  // clipboard (paste into Cursor / a GitHub issue / any agent).
  const copyEvidence = async () => {
    try {
      await navigator.clipboard.writeText(formatEvidencePack(capture));
      toast({ title: t('context.capture.evidenceCopied'), variant: 'success' });
    } catch (err) {
      toast({
        title: t('context.capture.copyFailed'),
        description: toMessage(err),
        variant: 'error',
      });
    }
  };
  return (
    <header className="flex items-start gap-2">
      <input
        type="checkbox"
        checked={selected}
        onChange={() => toggleSelected(id)}
        aria-label={t(selected ? 'context.capture.deselect' : 'context.capture.select')}
        className="mt-0.5 size-3.5 accent-accent shrink-0"
      />
      {children}
      <button
        type="button"
        onClick={() => void copyEvidence()}
        aria-label={t('context.capture.copyEvidence')}
        title={t('context.capture.copyEvidenceTitle')}
        className="text-fg-tertiary hover:text-fg-primary transition-colors duration-fast shrink-0"
      >
        <ClipboardCopy size={14} />
      </button>
      <button
        type="button"
        onClick={() => removeCapture(id)}
        aria-label={t('context.capture.remove')}
        className="text-fg-tertiary hover:text-fg-primary transition-colors duration-fast shrink-0"
      >
        <X size={14} />
      </button>
    </header>
  );
}

/** `url:line` → a short `basename:1-based-line` label (CDP lines are 0-based). */
function sourceLabel(source: ConsoleErrorCapture['source']): string {
  if (!source?.url) return '';
  let file: string;
  try {
    file = new URL(source.url).pathname.split('/').pop() || source.url;
  } catch {
    file = source.url.split('/').pop() || source.url;
  }
  return source.lineNumber !== undefined ? `${file}:${source.lineNumber + 1}` : file;
}

function ConsoleErrorCaptureCard({ capture }: { capture: ConsoleErrorCapture }) {
  const { t } = useI18n();
  const selected = useWebPageStore((s) => s.selectedCaptureIds.has(capture.id));
  const [expanded, setExpanded] = useState(false);
  const hasStack = capture.stack.length > 0;

  return (
    <article
      className={cn(
        'rounded border bg-surface-2 bg-surface-gradient shadow-card flex flex-col transition-colors duration-fast',
        selected ? 'border-default' : 'border-subtle opacity-70',
      )}
    >
      <div className="p-3 flex flex-col gap-2">
        <CardHeader capture={capture}>
          <button
            type="button"
            onClick={() => hasStack && setExpanded((e) => !e)}
            aria-expanded={hasStack ? expanded : undefined}
            className="flex items-center gap-2 min-w-0 text-left flex-1 group"
          >
            {hasStack ? (
              <span className="text-fg-tertiary group-hover:text-fg-secondary transition-colors duration-fast shrink-0">
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            <Badge variant="error">{t('context.capture.consoleError')}</Badge>
            <span
              className="font-mono text-caption text-fg-tertiary truncate"
              title={capture.source?.url}
            >
              {sourceLabel(capture.source) || t('context.capture.noSource')}
            </span>
          </button>
        </CardHeader>
        <div className="font-mono text-caption text-error break-words line-clamp-3">
          {capture.message}
        </div>
      </div>

      {expanded && hasStack ? (
        <div className="border-t border-subtle px-3 py-2 flex flex-col gap-1">
          <div className="text-caption text-fg-tertiary uppercase tracking-wide">
            {t('context.capture.stack')}
          </div>
          <ul className="flex flex-col gap-0.5">
            {capture.stack.slice(0, 8).map((f, i) => (
              <li key={i} className="font-mono text-caption text-fg-secondary truncate">
                <span className="text-fg-primary">
                  {f.functionName || t('context.capture.anonymous')}
                </span>
                {f.url ? (
                  <span className="text-fg-tertiary">
                    {' '}
                    {sourceLabel({ url: f.url, lineNumber: f.lineNumber })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

function ElementCaptureCard({ capture }: { capture: ElementCapture }) {
  const { t } = useI18n();
  const selected = useWebPageStore((s) => s.selectedCaptureIds.has(capture.id));
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
        'rounded border bg-surface-2 bg-surface-gradient shadow-card flex flex-col transition-colors duration-fast',
        selected ? 'border-default' : 'border-subtle opacity-70',
      )}
    >
      <div className="p-3 flex flex-col gap-2">
        <CardHeader capture={capture}>
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
        </CardHeader>
        <div className="font-mono text-caption text-fg-secondary break-all">
          {capture.selector || t('context.capture.noSelector')}
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
            {t('context.capture.relatedSource')}
          </div>
          {!summary ? (
            <div className="text-caption text-fg-tertiary">
              {t('context.capture.openWorkspace')}
            </div>
          ) : pending ? (
            <div className="text-caption text-fg-tertiary">{t('context.capture.ranking')}</div>
          ) : error ? (
            <div className="text-caption text-fg-tertiary break-all">
              {t('context.capture.errorPrefix')} {error}
            </div>
          ) : ranking === undefined ? null : ranking.length === 0 ? (
            <div className="text-caption text-fg-tertiary">
              {t('context.capture.noMatches')}
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
