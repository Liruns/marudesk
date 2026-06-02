import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search, Check, Brain, Eye, Star, FlaskConical } from 'lucide-react';
import { cn } from '../../lib/cn';
import {
  PROVIDERS,
  customProviderId,
  type ModelEntry,
  type ProviderId,
} from '../../../shared/providers';
import { useProvidersStore } from '../providers/store';
import { ProviderGlyph } from '../providers/ProviderGlyph';

/**
 * Command-palette model picker (docs/agentic-chat-v4-design.md §A1). A centered,
 * keyboard-first overlay over every tool-capable model: search-as-you-type,
 * Favorites + Recent quick groups (empty query only), provider grouping with
 * Experimental providers tucked last, capability badges, and 1–9 quick-select.
 * Replaces the old anchored combobox dropdown — the chip in {@link ProviderModelBar}
 * is now just the trigger.
 */
export function ModelPalette({ onClose }: { onClose: () => void }) {
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
      if (favItems.length) quick.push({ id: 'favorites', label: 'Favorites', items: favItems });
      const favSet = new Set(favoriteModelKeys);
      const recentItems = recentModelKeys
        .filter((k) => !favSet.has(k))
        .map(byKey)
        .filter((m): m is ModelEntry => !!m && m.tools !== false && isUsable(m));
      if (recentItems.length) quick.push({ id: 'recent', label: 'Recent', items: recentItems });
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
  }, [models, query, providerStatus, customProviders, recentModelKeys, favoriteModelKeys]);

  // Clamp the highlight to the (possibly shrunk) list on read — no state-syncing
  // effect needed; the arrow keys already clamp when moving and a query change
  // resets it to the top.
  const activeIndex = flat.length === 0 ? 0 : Math.min(active, flat.length - 1);

  // Scroll the highlighted row into view (DOM sync only — no setState).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const choose = (key: string) => {
    selectModel(key);
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
      <div className="relative mx-4 mt-[12vh] flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-default bg-surface-1 shadow-lg">
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
            placeholder="Search models…"
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
                ? `No connected models match “${query}”.`
                : 'No connected providers yet — add a key or sign in under Settings → AI Providers.'}
            </div>
          ) : (
            sections.map((s) => (
              <div key={s.id}>
                <div className="flex items-center gap-1.5 px-3 pb-1 pt-2.5 text-caption uppercase tracking-wider text-fg-tertiary">
                  <span>{s.label}</span>
                  {s.experimental ? (
                    <span className="inline-flex items-center gap-0.5 rounded-pill bg-warning-subtle px-1.5 py-px text-[10px] font-medium normal-case tracking-normal text-warning">
                      <FlaskConical size={9} /> experimental
                    </span>
                  ) : null}
                  {!s.experimental && s.id !== 'favorites' && s.id !== 'recent' ? (
                    <span
                      aria-hidden
                      title={s.hasKey ? 'Connected' : 'No key / not connected'}
                      className={cn('size-1.5 rounded-pill', s.hasKey ? 'bg-success' : 'bg-fg-tertiary/40')}
                    />
                  ) : null}
                </div>
                {s.items.map((m) => {
                  globalIndex += 1;
                  const idx = globalIndex;
                  const isActive = idx === activeIndex;
                  const isSelected = m.key === selectedModelKey;
                  const isFavorite = favoriteModelKeys.includes(m.key);
                  return (
                    <button
                      key={`${s.id}:${m.key}`}
                      ref={isActive ? activeRef : undefined}
                      type="button"
                      onClick={() => choose(m.key)}
                      onMouseEnter={() => setActive(idx)}
                      className={cn(
                        'group flex w-full items-center gap-2 px-3 py-1.5 text-left text-body-sm transition-colors',
                        isActive ? 'bg-surface-2 text-fg-primary' : 'text-fg-secondary',
                      )}
                    >
                      <ProviderGlyph provider={m.provider} label={m.label} size={18} />
                      {query.trim() === '' && idx < 9 ? (
                        <kbd className="shrink-0 rounded bg-surface-3 px-1 text-[10px] font-medium leading-[1.5] tabular-nums text-fg-tertiary">
                          {idx + 1}
                        </kbd>
                      ) : null}
                      <span className="flex-1 truncate">{m.label}</span>
                      {/* capability badges reuse the AI-timeline hues: vision=blue (read),
                          reasoning=peach (the same hue as the Thinking block). */}
                      {m.vision ? <Eye size={12} className="shrink-0 text-ai-read" aria-label="vision" /> : null}
                      {m.reasoning ? (
                        <Brain size={12} className="shrink-0 text-ai-thinking" aria-label="reasoning" />
                      ) : null}
                      {m.contextWindow ? (
                        <span className="shrink-0 rounded bg-surface-3/70 px-1 text-[10px] tabular-nums text-fg-tertiary">
                          {formatContext(m.contextWindow)}
                        </span>
                      ) : null}
                      {/* favorite: a real star icon (gold when set), hover-revealed otherwise */}
                      <span
                        role="button"
                        tabIndex={-1}
                        aria-label={isFavorite ? 'Unfavorite' : 'Favorite'}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(m.key);
                        }}
                        className={cn(
                          'shrink-0 transition-opacity',
                          isFavorite ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                        )}
                      >
                        <Star
                          size={13}
                          className={cn(isFavorite ? 'text-warning' : 'text-fg-tertiary/60 hover:text-fg-tertiary')}
                          fill={isFavorite ? 'currentColor' : 'none'}
                        />
                      </span>
                      {isSelected ? (
                        <Check size={13} className="shrink-0 text-accent" />
                      ) : (
                        <span aria-hidden className="w-[13px] shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* footer hint bar */}
        <div className="flex shrink-0 items-center gap-2.5 border-t border-subtle px-3 py-1.5 text-caption text-fg-tertiary">
          <Hint k="↑↓" label="move" />
          <Hint k="↵" label="select" />
          <Hint k="1–9" label="quick" />
          <Hint k="esc" label="close" />
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

/** One footer key hint: a kbd chip + its action label. */
function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded bg-surface-3 px-1 text-[10px] font-medium leading-[1.5] text-fg-secondary">
        {k}
      </kbd>
      <span>{label}</span>
    </span>
  );
}

/** Compact context-window label (e.g. 200000 → "200K", 1048576 → "1M"). */
function formatContext(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
