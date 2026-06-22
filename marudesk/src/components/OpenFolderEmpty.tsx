import type { ComponentType } from 'react';
import { FolderOpen, FolderSearch } from 'lucide-react';
import { cn } from '../lib/cn';
import { Spinner } from './ui';
import { useI18n } from '../i18n/useI18n';
import { useWorkspaceStore } from '../features/workspace/store';

/**
 * The shared "no folder open" empty state for workspace-gated instruments
 * (Source Control, Search, Explorer). Replaces raw "no workspace is open" errors
 * with a friendly, consistent prompt and a real "Open folder" action, so every
 * gated surface reads as finished — not broken — before a project is opened.
 *
 * Mirrors the Explorer's polished empty state (the established pattern) and wires
 * straight to {@link useWorkspaceStore.openWorkspace} (the native folder picker).
 */
export function OpenFolderEmpty({
  title,
  body,
  icon: Icon = FolderSearch,
}: {
  title?: string;
  body?: string;
  icon?: ComponentType<{ size?: number }>;
}) {
  const { t } = useI18n();
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const opening = useWorkspaceStore((s) => s.opening);
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="size-10 rounded-lg bg-surface-2 flex items-center justify-center text-fg-tertiary">
        <Icon size={20} />
      </span>
      <p className="text-body-sm text-fg-secondary">{title ?? t('workspace.emptyState.title')}</p>
      <p className="max-w-xs text-caption text-fg-tertiary">{body ?? t('workspace.emptyState.body')}</p>
      <button
        type="button"
        onClick={() => void openWorkspace()}
        disabled={opening}
        className={cn(
          'mt-1 inline-flex items-center gap-2 h-8 px-3 rounded-md text-body-sm',
          'bg-accent text-white transition-opacity duration-fast',
          opening ? 'opacity-60 cursor-not-allowed' : 'hover:opacity-90',
        )}
      >
        {opening ? <Spinner size={14} /> : <FolderOpen size={15} />}
        {t('workspace.action.openFolder')}
      </button>
    </div>
  );
}
