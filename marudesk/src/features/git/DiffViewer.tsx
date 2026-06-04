import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { DiffBlock } from '../../components/ui';
import { Spinner } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { toMessage } from '../../lib/toMessage';
import { parseUnifiedDiff } from './parseDiff';

/**
 * A centered overlay showing the unified diff for one file (staged or not).
 * Mirrors the ModelPalette overlay shell (backdrop + centered card + Esc to
 * close); the body reuses the shared DiffBlock renderer via parseUnifiedDiff.
 */
export function DiffViewer({
  path,
  staged,
  onClose,
}: {
  path: string;
  staged: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // This component is mounted fresh per target (the parent keys it on
  // path+staged), so path/staged never change during its life — no in-effect
  // reset is needed, and setState only ever runs in the async callbacks.
  useEffect(() => {
    let alive = true;
    window.marudesk
      .invoke('git:diff', { path, staged })
      .then((res) => {
        if (alive) setDiff(res.diff);
      })
      .catch((err) => {
        if (alive) setError(toMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [path, staged]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const lines = useMemo(() => (diff ? parseUnifiedDiff(diff) : []), [diff]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={`${t('git.diff.dialogLabel')} ${path}`}
    >
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/30"
        onClick={onClose}
      />
      <div className="relative mx-4 mt-[10vh] flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-default bg-surface-1 shadow-lifted animate-scale-in">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-subtle pl-3 pr-1.5">
          <span className="truncate font-mono text-body-sm text-fg-secondary" title={path}>
            {path}
          </span>
          {staged ? (
            <span className="shrink-0 rounded-pill bg-success/15 px-1.5 py-px text-[10px] font-medium text-success">
              {t('git.section.staged')}
            </span>
          ) : null}
          <span className="flex-1" aria-hidden />
          <button
            type="button"
            onClick={onClose}
            aria-label={t('git.diff.close')}
            title={t('git.diff.close')}
            className={cn(
              'size-7 rounded flex items-center justify-center shrink-0',
              'text-fg-tertiary hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast',
            )}
          >
            <X size={15} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {error ? (
            <p className="text-body-sm text-error">{error}</p>
          ) : diff === null ? (
            <div className="flex items-center justify-center gap-2 py-10 text-fg-tertiary">
              <Spinner size={16} /> {t('git.diff.loading')}
            </div>
          ) : lines.length === 0 ? (
            <p className="py-10 text-center text-body-sm text-fg-tertiary">
              {t('git.diff.empty')}
            </p>
          ) : (
            <DiffBlock filePath={path} lines={lines} />
          )}
        </div>
      </div>
    </div>
  );
}
