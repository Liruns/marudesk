import { useMemo, type ReactNode } from 'react';
import { CornerDownLeft } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import type { SettingsCategoryItem } from './settingsCategories';
import { SETTINGS_CATALOG } from './settingsCatalog';
import type { SettingsCategory } from './store';

type Props = {
  query: string;
  categories: readonly SettingsCategoryItem[];
  onPick: (category: SettingsCategory) => void;
};

/**
 * Cross-category settings finder. Given a query it surfaces matching individual
 * settings from {@link SETTINGS_CATALOG} — each a button that jumps to the owning
 * category — so a user can search for a control by name ("shell", "fallback",
 * "reasoning") instead of guessing which category holds it. Category-level
 * navigation stays in the always-visible left nav, so this list focuses on the
 * settings themselves.
 */
export function SettingsSearchResults({ query, categories, onPick }: Props) {
  const { t } = useI18n();
  const q = query.trim().toLowerCase();

  const categoryById = useMemo(() => {
    const map = new Map<SettingsCategory, SettingsCategoryItem>();
    for (const c of categories) map.set(c.id, c);
    return map;
  }, [categories]);

  const matches = useMemo(
    () =>
      SETTINGS_CATALOG.filter((entry) => {
        const label = t(entry.labelKey).toLowerCase();
        return label.includes(q) || entry.keywords.includes(q);
      }),
    [q, t],
  );

  if (matches.length === 0) {
    return (
      <p className="text-body-sm text-fg-tertiary">{t('settings.noMatches')}</p>
    );
  }

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="px-1 text-caption uppercase tracking-wider text-fg-tertiary">
        {t('settings.search.settingsGroup')}
      </h3>
      <div className="flex flex-col rounded-lg border border-subtle bg-surface-1 shadow-highlight divide-y divide-subtle">
        {matches.map((entry, i) => {
          const cat = categoryById.get(entry.categoryId);
          return (
            <ResultRow
              key={`${entry.categoryId}-${entry.labelKey}-${i}`}
              icon={cat ? <cat.icon size={15} /> : null}
              title={t(entry.labelKey)}
              badge={cat?.label}
              onClick={() => onPick(entry.categoryId)}
            />
          );
        })}
      </div>
    </section>
  );
}

function ResultRow({
  icon,
  title,
  badge,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-center gap-3 px-4 py-3 text-left',
        'transition-colors duration-fast hover:bg-surface-2',
      )}
    >
      <span className="shrink-0 text-fg-tertiary group-hover:text-accent" aria-hidden>
        {icon}
      </span>
      <span className="flex-1 min-w-0 text-body-sm text-fg-primary truncate">
        {title}
      </span>
      {badge ? (
        // Decorative category context only — kept out of the button's accessible
        // name (which stays the setting label) so it reads cleanly.
        <span
          aria-hidden
          className="shrink-0 rounded-pill bg-surface-2 px-2 py-0.5 text-caption text-fg-tertiary"
        >
          {badge}
        </span>
      ) : null}
      <CornerDownLeft
        size={13}
        aria-hidden
        className="shrink-0 text-fg-tertiary opacity-0 group-hover:opacity-100 transition-opacity duration-fast"
      />
    </button>
  );
}
