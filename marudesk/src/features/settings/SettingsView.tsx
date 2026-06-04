import { useMemo, useState } from 'react';
import { Search as SearchIcon } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { AgentCategory } from './AgentSettingsCategory';
import { AboutCategory } from './AboutSettingsCategory';
import { DataCategory } from './DataSettingsCategory';
import {
  AppearanceCategory,
  BrowserCategory,
  DevtoolsCategory,
  EditorCategory,
  TerminalCategory,
} from './GeneralSettingsCategories';
import { McpServersSettings } from './McpServersSettings';
import { ProvidersSettings } from './ProvidersSettings';
import { RemoteCategory } from './RemoteSettingsCategory';
import { NavItem } from './SettingsControls';
import { getSettingsCategories } from './settingsCategories';
import { SettingsSearchResults } from './SettingsSearchResults';
import { type SettingsCategory, useSettingsStore } from './store';

export function SettingsView() {
  const { t } = useI18n();
  const category = useSettingsStore((s) => s.category);
  const setCategory = useSettingsStore((s) => s.setCategory);
  const categories = useMemo(() => getSettingsCategories(t), [t]);
  const active = categories.find((c) => c.id === category);
  const [filter, setFilter] = useState('');
  const searching = filter.trim().length > 0;

  const pickResult = (next: SettingsCategory) => {
    setCategory(next);
    setFilter('');
  };

  if (!active) return null;

  return (
    <div className="flex-1 min-h-0 flex bg-surface-page">
      <aside className="w-52 shrink-0 flex flex-col border-r border-subtle bg-surface-1">
        <header className="h-11 shrink-0 flex items-center px-4 border-b border-subtle">
          <h1 className="text-body font-medium text-fg-primary">{t('settings.title')}</h1>
        </header>
        <div className="shrink-0 px-2 pt-2">
          <div className="flex items-center gap-1.5 h-7 rounded-md bg-surface-page border border-subtle px-2 focus-within:border-accent">
            <SearchIcon size={13} className="shrink-0 text-fg-tertiary" aria-hidden />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && filter) {
                  e.preventDefault();
                  setFilter('');
                }
              }}
              placeholder={t('settings.search.placeholder')}
              spellCheck={false}
              aria-label={t('settings.search.aria')}
              className="flex-1 min-w-0 bg-transparent text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
            />
          </div>
        </div>
        <nav
          aria-label={t('settings.categoriesLabel')}
          className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-0.5"
        >
          {categories.map((c) => (
            <NavItem
              key={c.id}
              active={!searching && c.id === category}
              onClick={() => pickResult(c.id)}
              icon={<c.icon size={15} />}
              label={c.label}
            />
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-2xl px-8 py-8 flex flex-col gap-6">
          {searching ? (
            <>
              <header className="flex flex-col gap-1">
                <h2 className="text-section text-fg-primary">
                  {t('settings.search.resultsTitle')}
                </h2>
                <p className="text-body-sm text-fg-tertiary">
                  {t('settings.search.resultsBlurb')}
                </p>
              </header>
              <SettingsSearchResults
                query={filter}
                categories={categories}
                onPick={pickResult}
              />
            </>
          ) : (
            <>
              <header className="flex flex-col gap-1">
                <h2 className="text-section text-fg-primary">{active.label}</h2>
                <p className="text-body-sm text-fg-tertiary">{active.blurb}</p>
              </header>
              {category === 'appearance' ? <AppearanceCategory /> : null}
              {category === 'editor' ? <EditorCategory /> : null}
              {category === 'terminal' ? <TerminalCategory /> : null}
              {category === 'browser' ? <BrowserCategory /> : null}
              {category === 'providers' ? <ProvidersSettings /> : null}
              {category === 'agent' ? <AgentCategory /> : null}
              {category === 'mcp' ? <McpServersSettings /> : null}
              {category === 'devtools' ? <DevtoolsCategory /> : null}
              {category === 'remote' ? <RemoteCategory /> : null}
              {category === 'data' ? <DataCategory /> : null}
              {category === 'about' ? <AboutCategory /> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
