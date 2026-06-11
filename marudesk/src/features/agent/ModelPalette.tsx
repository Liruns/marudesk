import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import {
  PROVIDERS,
  customProviderId,
  type ModelEntry,
  type ProviderId,
} from '../../../shared/providers';
import { useProvidersStore } from '../providers/store';
import { useI18n } from '../../i18n/useI18n';
import { Hint } from './ModelPaletteParts';
import { ModelRow, SectionHeader } from './ModelPaletteRow';

/**
 * Command-palette model picker (docs/agentic-chat-v4-design.md §A1). A centered,
 * keyboard-first overlay over every tool-capable model: search-as-you-type,
 * Favorites + Recent quick groups (empty query only), provider grouping with
 * Experimental providers tucked last, capability badges, and 1–9 quick-select.
 * Replaces the old anchored combobox dropdown — the chip in {@link ProviderModelBar}
 * is now just the trigger.
 */
export function ModelPalette({
  onClose,
  selectedKey,
  onPick,
}: {
  onClose: () => void;
  /** Highlight override — e.g. the active thread's pinned model (defaults to the global selection). */
  selectedKey?: string;
  /** Selection override — route the pick somewhere other than the global store. */
  onPick?: (key: string) => void;
}) {
  const { t } = useI18n();
  const models = useProvidersStore((s) => s.models);
  const selectedModelKey = useProvidersStore((s) => s.selectedModelKey);
  const providerStatus = useProvidersStore((s) => s.providerStatus);
  const customProviders = useProvidersStore((s) => s.customProviders);
  const recentModelKeys = useProvidersStore((s) => s.recentModelKeys);
  const favoriteModelKeys = useProvidersStore((s) => s.favoriteModelKeys);
  const selectModel = useProvidersStore((s) => s.selectModel);
  const toggleFavorite = useProvidersStore((s) => s.toggleFavorite);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // Focus the search input on mount. The palette is mounted only while open (the
  // parent renders it conditionally), so mounting *is* opening — query/active start
  // fresh with no reset effect, and we never call setState inside an effect.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  // Hide the embedded web view while the palette is open. The picker is a
  // `fixed inset-0` overlay, but an active web tab's WebContentsView is a native
  // layer composited OVER the React DOM — so over a browser tab the palette would
  // render *behind* the page and look like nothing happened (the "I clicked the
  // model list but it never shows" bug). Restored on close. No-op when the active
  // tab owns no view (feature tabs / no web tab). Mirrors ContextMenu / overlays.
  useEffect(() => {
    void window.marudesk.invoke('browser:set-visible', false);
    return () => {
      void window.marudesk.invoke('browser:set-visible', true);
    };
  }, []);

  const { sections, flat } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (m: ModelEntry) =>
      m.tools !== false &&
      (q === '' || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    const byKey = (k: string) => models.find((m) => m.key === k);
    // "Connected" = a usable auth path: an API key, a keyless provider (Ollama
    // reports hasKey), OR an OAuth subscription login (Claude Pro etc.). Mirrors
    // hasKeyForSelected so the picker and composer agree on what's usable — an
    // OAuth-only provider has hasKey=false but oauth=true.
    const keyById = (id: ProviderId) => {
      const st = providerStatus.find((s) => s.id === id);
      return !!st?.hasKey || !!st?.oauth;
    };
    // A model is usable if its provider is connected or it's a user-added custom
    // endpoint — drives the "only show what I can actually run" filter.
    const isUsable = (m: ModelEntry) => m.provider.startsWith('custom:') || keyById(m.provider);
    const itemsFor = (id: ProviderId) => models.filter((m) => m.provider === id && matches(m));

    const quick: Section[] = [];
    if (q === '') {
      const favItems = favoriteModelKeys
        .map(byKey)
        .filter((m): m is ModelEntry => !!m && m.tools !== false && isUsable(m));
      if (favItems.length) quick.push({ id: 'favorites', label: t('agent.modelPalette.favorites'), items: favItems });
      const favSet = new Set(favoriteModelKeys);
      const recentItems = recentModelKeys
        .filter((k) => !favSet.has(k))
        .map(byKey)
        .filter((m): m is ModelEntry => !!m && m.tools !== false && isUsable(m));
      if (recentItems.length) quick.push({ id: 'recent', label: t('agent.modelPalette.recent'), items: recentItems });
    }

    const builtin: Section[] = PROVIDERS.filter((p) => !p.experimental).map((p) => ({
      id: p.id as ProviderId,
      label: p.label,
      hasKey: keyById(p.id),
      items: itemsFor(p.id),
    }));
    const custom: Section[] = customProviders.map((c) => ({
      id: customProviderId(c.id),
      label: c.label,
      hasKey: keyById(customProviderId(c.id)),
      items: itemsFor(customProviderId(c.id)),
    }));
    const experimental: Section[] = PROVIDERS.filter((p) => p.experimental).map((p) => ({
      id: p.id as ProviderId,
      label: p.label,
      hasKey: keyById(p.id),
      experimental: true,
      items: itemsFor(p.id),
    }));

    // Hide providers the user can't use yet — no key/login means every model
    // there is a dead end. Favorites/Recent are already filtered to usable models;
    // user-added custom endpoints always show.
    const all: Section[] = [...quick, ...builtin, ...custom, ...experimental].filter(
      (s) =>
        s.items.length > 0 &&
        (s.id === 'favorites' || s.id === 'recent' || s.id.startsWith('custom:') || s.hasKey),
    );
    return { sections: all, flat: all.flatMap((s) => s.items) };
  }, [models, query, providerStatus, customProviders, recentModelKeys, favoriteModelKeys, t]);

  // Clamp the highlight to the (possibly shrunk) list on read — no state-syncing
  // effect needed; the arrow keys already clamp when moving and a query change
  // resets it to the top.
  const activeIndex = flat.length === 0 ? 0 : Math.min(active, flat.length - 1);

  // Scroll the highlighted row into view (DOM sync only — no setState).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const choose = (key: string) => {
    if (onPick) onPick(key);
    else selectModel(key);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const m = flat[activeIndex];
      if (m) choose(m.key);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (query.trim() === '' && /^[1-9]$/.test(e.key)) {
      // Quick-select the Nth visible model (Claude's 1–9 trick) — only when not
      // typing a query, so digits in a search term stay literal.
      const idx = Number(e.key) - 1;
      if (idx < flat.length) {
        e.preventDefault();
        choose(flat[idx].key);
      }
    }
  };

  let globalIndex = -1;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/30"
        onClick={onClose}
      />
      <div className="relative mx-4 mt-[12vh] flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-default bg-surface-1 shadow-lifted animate-scale-in">
        {/* search */}
        <div className="flex shrink-0 items-center gap-2 border-b border-subtle px-3 h-11">
          <Search size={15} className="shrink-0 text-fg-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={t('agent.modelPalette.searchPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
          />
        </div>

        {/* list */}
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {sections.length === 0 ? (
            <div className="px-3 py-6 text-center text-caption text-fg-tertiary">
              {query.trim()
                ? `${t('agent.modelPalette.noMatchBefore')}${query}${t('agent.modelPalette.noMatchAfter')}`
                : t('agent.modelPalette.noProviders')}
            </div>
          ) : (
            sections.map((s) => (
              <div key={s.id}>
                <SectionHeader
                  label={s.label}
                  experimental={!!s.experimental}
                  hasKey={!!s.hasKey}
                  showStatus={!s.experimental && s.id !== 'favorites' && s.id !== 'recent'}
                  experimentalLabel={t('agent.modelPalette.experimental')}
                  connectedTitle={t('agent.modelPalette.connected')}
                  notConnectedTitle={t('agent.modelPalette.notConnected')}
                />
                {s.items.map((m) => {
                  globalIndex += 1;
                  const idx = globalIndex;
                  const isFavorite = favoriteModelKeys.includes(m.key);
                  return (
                    <ModelRow
                      key={`${s.id}:${m.key}`}
                      model={m}
                      index={idx}
                      rowRef={idx === activeIndex ? activeRef : undefined}
                      active={idx === activeIndex}
                      selected={m.key === (selectedKey ?? selectedModelKey)}
                      favorite={isFavorite}
                      showQuickKey={query.trim() === '' && idx < 9}
                      visionLabel={t('agent.modelPalette.vision')}
                      reasoningLabel={t('agent.modelPalette.reasoning')}
                      favoriteLabel={t('agent.modelPalette.favorite')}
                      unfavoriteLabel={t('agent.modelPalette.unfavorite')}
                      onChoose={() => choose(m.key)}
                      onHover={() => setActive(idx)}
                      onToggleFavorite={() => toggleFavorite(m.key)}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* footer hint bar */}
        <div className="flex shrink-0 items-center gap-2.5 border-t border-subtle px-3 py-1.5 text-caption text-fg-tertiary">
          <Hint k="↑↓" label={t('palette.hint.move')} />
          <Hint k="↵" label={t('agent.modelPalette.select')} />
          <Hint k="1–9" label={t('agent.modelPalette.quick')} />
          <Hint k="esc" label={t('palette.hint.close')} />
        </div>
      </div>
    </div>
  );
}

type Section = {
  id: string;
  label: string;
  hasKey?: boolean;
  experimental?: boolean;
  items: ModelEntry[];
};
