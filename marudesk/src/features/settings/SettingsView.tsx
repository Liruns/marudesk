import { useMemo, useState } from 'react';
import { Search as SearchIcon } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { AgentCategory } from './AgentSettingsCategory';
import { DataCategory, AboutCategory } from './DataSettingsCategory';
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
import { useSettingsStore } from './store';

export function SettingsView() {
  const { t } = useI18n();
  const category = useSettingsStore((s) => s.category);
  const setCategory = useSettingsStore((s) => s.setCategory);
  const categories = useMemo(() => getSettingsCategories(t), [t]);
  const active = categories.find((c) => c.id === category);
  const [filter, setFilter] = useState('');

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.blurb.toLowerCase().includes(q) ||
        c.keywords.includes(q),
    );
  }, [categories, filter]);

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
          {shown.map((c) => (
            <NavItem
              key={c.id}
              active={c.id === category}
              onClick={() => setCategory(c.id)}
              icon={<c.icon size={15} />}
              label={c.label}
            />
          ))}
          {shown.length === 0 ? (
            <p className="px-3 py-2 text-caption text-fg-tertiary">
              {t('settings.noMatches')}
            </p>
          ) : null}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-2xl px-8 py-8 flex flex-col gap-6">
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
        </div>
      </div>
    </div>
  );
}
