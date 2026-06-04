import { FolderOpen, Pause, Play, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useDownloadsStore } from './downloads';
import type { DownloadEntry } from '../../../shared/downloads';
import { useBrowserStrings } from './browserStrings';

/**
 * Bottom download shelf (old-Chrome style). Rendered as a `shrink-0` flex
 * sibling beneath the browser stage so the embedded web view shrinks up to make
 * room — a stage overlay would be hidden behind the native view. Lists each
 * download as a compact chip with progress + per-state actions.
 */
export function DownloadShelf() {
  const { t } = useBrowserStrings();
  const downloads = useDownloadsStore((s) => s.downloads);
  const closeShelf = useDownloadsStore((s) => s.closeShelf);
  const clearFinished = useDownloadsStore((s) => s.clearFinished);
  const hasFinished = downloads.some(
    (d) => d.state !== 'progressing' && d.state !== 'paused',
  );

  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-surface-1 border-t border-subtle">
      <div className="flex-1 min-w-0 flex items-center gap-2 overflow-x-auto scrollbar-none">
        {downloads.map((d) => (
          <DownloadChip key={d.id} entry={d} />
        ))}
      </div>
      {hasFinished ? (
        <button
          type="button"
          onClick={clearFinished}
          className="shrink-0 text-caption text-fg-secondary hover:text-fg-primary px-2 py-1 rounded hover:bg-surface-2 transition-colors duration-fast"
        >
          {t('browser.downloads.clearFinished')}
        </button>
      ) : null}
      <button
        type="button"
        onClick={closeShelf}
        aria-label={t('browser.downloads.hide')}
        title={t('browser.downloads.hide')}
        className="shrink-0 size-6 rounded flex items-center justify-center text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary transition-colors duration-fast"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function DownloadChip({ entry }: { entry: DownloadEntry }) {
  const { t, formatDownloadStatus } = useBrowserStrings();
  const act = useDownloadsStore((s) => s.act);
  const { state, receivedBytes, totalBytes } = entry;
  const active = state === 'progressing' || state === 'paused';
  const pct =
    totalBytes > 0 ? Math.min(100, (receivedBytes / totalBytes) * 100) : null;
  const statusText = formatDownloadStatus(entry);

  return (
    <div className="shrink-0 w-60 rounded-md border border-subtle bg-surface-page px-2.5 py-1.5 flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            if (state === 'completed') act(entry.id, 'open');
          }}
          disabled={state !== 'completed'}
          title={entry.filename}
          className={cn(
            'flex-1 min-w-0 text-left truncate text-body-sm text-fg-primary',
            state === 'completed'
              ? 'hover:underline'
              : 'cursor-default',
          )}
        >
          {entry.filename}
        </button>
        {active ? (
          <>
            <ChipBtn
              label={t(state === 'paused' ? 'browser.downloads.resume' : 'browser.downloads.pause')}
              onClick={() => act(entry.id, state === 'paused' ? 'resume' : 'pause')}
            >
              {state === 'paused' ? <Play size={13} /> : <Pause size={13} />}
            </ChipBtn>
            <ChipBtn label={t('browser.downloads.cancel')} onClick={() => act(entry.id, 'cancel')}>
              <X size={13} />
            </ChipBtn>
          </>
        ) : (
          <>
            {state === 'completed' ? (
              <ChipBtn
                label={t('browser.downloads.showInFolder')}
                onClick={() => act(entry.id, 'show')}
              >
                <FolderOpen size={13} />
              </ChipBtn>
            ) : null}
            <ChipBtn label={t('browser.downloads.remove')} onClick={() => act(entry.id, 'remove')}>
              <X size={13} />
            </ChipBtn>
          </>
        )}
      </div>
      {active && pct !== null ? (
        <div className="h-1 rounded-pill bg-surface-3 overflow-hidden">
          <div
            className="h-full bg-accent transition-[width] duration-fast"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
      <span
        className={cn(
          'text-caption truncate',
          state === 'interrupted' || state === 'cancelled'
            ? 'text-warning'
            : 'text-fg-tertiary',
        )}
      >
        {statusText}
      </span>
    </div>
  );
}

function ChipBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="shrink-0 size-5 rounded flex items-center justify-center text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary transition-colors duration-fast"
    >
      {children}
    </button>
  );
}
