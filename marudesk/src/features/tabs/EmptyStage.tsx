import { FilePlus2, Plus } from 'lucide-react';
import type { WorkspaceId } from '../../../shared/workspace';
import { useI18n } from '../../i18n/useI18n';
import { useTabsStore } from './store';

/**
 * Shown when a workspace pane has NO open tabs — distinct from the New Tab
 * dashboard (HomeView). Closing the last tab no longer forces a home tab, so this
 * is the resting state for an empty pane, with quick ways back in.
 */
export function EmptyStage({ workspaceId }: { workspaceId?: WorkspaceId }) {
  const { t } = useI18n();
  const newTab = useTabsStore((s) => s.newTab);

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col items-center justify-center gap-5 bg-surface-page bg-vignette">
      <div className="flex flex-col items-center gap-1 text-center animate-fade-rise">
        <h2 className="text-body font-medium text-fg-secondary">{t('stage.empty.title')}</h2>
        <p className="text-caption text-fg-tertiary">{t('stage.empty.subtitle')}</p>
      </div>
      <div className="flex items-center gap-2 animate-fade-rise [animation-delay:80ms]">
        <button
          type="button"
          onClick={() => void newTab('home', undefined, workspaceId)}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-body-sm font-medium text-white transition-opacity duration-fast hover:opacity-90"
        >
          <Plus size={15} />
          {t('stage.empty.newTab')}
        </button>
        <button
          type="button"
          onClick={() => void newTab('editor', undefined, workspaceId)}
          className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-3 py-1.5 text-body-sm text-fg-secondary transition-colors duration-fast hover:text-fg-primary hover:bg-surface-3"
        >
          <FilePlus2 size={15} />
          {t('stage.empty.newEditor')}
        </button>
      </div>
    </div>
  );
}
