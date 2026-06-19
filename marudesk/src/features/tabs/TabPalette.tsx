import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Search } from 'lucide-react';
import { cn } from '../../lib/cn';
import { fuzzyScore } from '../search/fuzzy';
import { useTabsStore } from './store';
import { tabKinds } from './registry';
import { useCanvasStore } from '../canvas/store';
import { useSurfaceStore } from '../canvas/surface';
import type { TabState } from '../../../shared/browser';
import { useI18n } from '../../i18n/useI18n';
import type { TranslationKey } from '../../i18n/messages';

/**
 * Tab switcher palette (Ctrl/Cmd+Shift+A). A keyboard-first overlay that
 * fuzzy-matches the open tabs by title + url and activates the chosen one —
 * Chrome's "Search tabs" for a strip that's overflowed or split. Mirrors
 * QuickOpen's overlay shell + keyboard model (↑↓/Enter/Esc, mount = open).
 */
const MAX_RESULTS = 50;

/** The text a tab matches on: its display label plus the page url for web tabs. */
function tabKindLabel(tab: TabState, t: (key: TranslationKey) => string): string {
  return t(`tabs.kind.${tab.kind}` as TranslationKey);
}

function tabHaystack(tab: TabState, t: (key: TranslationKey) => string): string {
  const label = tab.title || tabKindLabel(tab, t);
  return tab.kind === 'web' ? `${label} ${tab.url}` : label;
}

function tabLabel(tab: TabState, t: (key: TranslationKey) => string): string {
  return tab.title || tabKindLabel(tab, t);
}

export function TabPalette({ onClose }: { onClose: () => void }) {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activateTab = useTabsStore((s) => s.activateTab);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const { formatTabPaletteNoMatch, t } = useI18n();

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const results = useMemo(() => {
    const q = query.trim();
    if (q === '') return tabs.slice(0, MAX_RESULTS).map((tab) => ({ tab }));
    const scored: { tab: TabState; score: number }[] = [];
    for (const tab of tabs) {
      const r = fuzzyScore(q, tabHaystack(tab, t));
      if (r) scored.push({ tab, score: r.score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS);
  }, [tabs, query, t]);

  const activeIndex = results.length === 0 ? 0 : Math.min(active, results.length - 1);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const choose = (id: string) => {
    void activateTab(id);
    // On the infinite canvas, also pan/zoom to the picked card — otherwise
    // activating a tab off-screen leaves you staring at empty canvas.
    if (useSurfaceStore.getState().mode === 'canvas') {
      useCanvasStore.getState().revealTab(id);
    }
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[activeIndex];
      if (r) choose(r.tab.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={t('tabPalette.dialogLabel')}
    >
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/30"
        onClick={onClose}
      />
      <div className="relative mx-4 mt-[12vh] flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-default bg-surface-1 shadow-lifted animate-scale-in">
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
            placeholder={t('tabPalette.placeholder')}
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-caption text-fg-tertiary">
              {formatTabPaletteNoMatch(query)}
            </div>
          ) : (
            results.map(({ tab }, idx) => {
              const isActive = idx === activeIndex;
              const Icon = tabKinds[tab.kind].icon;
              return (
                <button
                  key={tab.id}
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  onClick={() => choose(tab.id)}
                  onMouseEnter={() => setActive(idx)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-body-sm transition-colors',
                    isActive ? 'bg-surface-2 text-fg-primary' : 'text-fg-secondary',
                  )}
                >
                  {tab.favicon ? (
                    <img src={tab.favicon} alt="" aria-hidden className="size-3.5 shrink-0 rounded-sm" />
                  ) : (
                    <Icon size={14} />
                  )}
                  <span className="shrink-0 max-w-[45%] truncate">{tabLabel(tab, t)}</span>
                  {tab.kind === 'web' && tab.url ? (
                    <span className="min-w-0 flex-1 truncate text-caption text-fg-tertiary">
                      {tab.url}
                    </span>
                  ) : null}
                  {tab.id === activeTabId ? (
                    <span className="ml-auto shrink-0 text-caption text-fg-tertiary">
                      {t('tabPalette.current')}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2.5 border-t border-subtle px-3 py-1.5 text-caption text-fg-tertiary">
          <Hint k="↑↓" label={t('palette.hint.move')} />
          <Hint k="↵" label={t('tabPalette.hint.switch')} />
          <Hint k="esc" label={t('palette.hint.close')} />
        </div>
      </div>
    </div>
  );
}

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
