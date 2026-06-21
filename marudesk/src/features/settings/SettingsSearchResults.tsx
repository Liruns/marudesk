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

  const categoryById = useMemo(() => {
    const map = new Map<SettingsCategory, SettingsCategoryItem>();
    for (const c of categories) map.set(c.id, c);
    return map;
  }, [categories]);

  // A query matching a category's own label/blurb/keywords surfaces that
  // category's settings too, so broad terms like "data" or "wrap" still find
  // their home — the per-setting catalog alone wouldn't carry those synonyms.
  const categoryText = useMemo(() => {
    const map = new Map<SettingsCategory, string>();
    for (const c of categories) {
      map.set(
        c.id,
        `${c.label} ${c.blurb} ${c.keywords}`.toLowerCase(),
      );
    }
    return map;
  }, [categories]);

  // Every whitespace-separated token must appear somewhere in the entry's
  // searchable text, so multi-word queries ("font size", "editor wrap") narrow
  // rather than silently miss.
  const tokens = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );

  const matches = useMemo(
    () =>
      SETTINGS_CATALOG.filter((entry) => {
        const haystack = `${t(entry.labelKey).toLowerCase()} ${entry.keywords} ${categoryText.get(entry.categoryId) ?? ''}`;
        return tokens.every((token) => haystack.includes(token));
      }),
    [tokens, categoryText, t],
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
      <div className="chrome-panel flex flex-col rounded-lg overflow-hidden divide-y divide-subtle">
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
        'chrome-list-row group gap-2 px-4 py-2 text-left rounded-none',
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
