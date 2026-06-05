import { useMemo, useState } from 'react';
import { Folder } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { useWorkspaceStore } from '../workspace/store';

export function HomeRecents() {
  const { t } = useI18n();
  const recents = useWorkspaceStore((s) => s.recents);
  const openRecent = useWorkspaceStore((s) => s.openRecent);
  const [recentFilter, setRecentFilter] = useState('');
  const filteredRecents = useMemo(() => {
    const q = recentFilter.trim().toLowerCase();
    if (!q) return recents;
    return recents.filter(
      (r) => r.name.toLowerCase().includes(q) || r.root.toLowerCase().includes(q),
    );
  }, [recents, recentFilter]);

  if (recents.length === 0) return null;

  return (
    <div className="chrome-panel w-full max-w-2xl flex flex-col gap-0.5 rounded-lg p-2 animate-fade-rise [animation-delay:180ms]">
      <div className="flex items-center gap-2 px-1 pb-1">
        <p className="text-caption uppercase tracking-wider text-fg-tertiary">
          {t('home.recents.label')}
        </p>
        {recents.length > 5 ? (
          <input
            value={recentFilter}
            onChange={(e) => setRecentFilter(e.target.value)}
            placeholder={t('home.recents.filter.placeholder')}
            spellCheck={false}
            aria-label={t('home.recents.filter.aria')}
            className="ml-auto h-6 w-32 rounded bg-surface-page border border-subtle px-2 text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-accent shadow-inset-soft"
          />
        ) : null}
      </div>
      {filteredRecents.length === 0 ? (
        <p className="px-3 py-2 text-caption text-fg-tertiary">
          {t('home.recents.noMatches')}
        </p>
      ) : null}
      {filteredRecents.map((r) => (
        <button
          key={r.root}
          type="button"
          onClick={() => void openRecent(r.root)}
          className={cn(
            'chrome-list-row group gap-2.5 px-3 py-2 text-left',
          )}
        >
          <Folder
            size={15}
            className="shrink-0 text-fg-tertiary group-hover:text-accent transition-colors duration-fast"
          />
          <span className="shrink-0 text-body-sm text-fg-secondary group-hover:text-fg-primary">
            {r.name}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-caption text-fg-tertiary"
            title={r.root}
          >
            {r.root}
          </span>
        </button>
      ))}
    </div>
  );
}
