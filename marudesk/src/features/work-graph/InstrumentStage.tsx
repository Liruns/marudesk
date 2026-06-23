import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, Maximize2, Minimize2, SplitSquareHorizontal, X } from 'lucide-react';
import { tabKinds } from '../tabs/registry';
import { useTabsStore } from '../tabs/store';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import type { TranslationKey } from '../../i18n/messages';
import { useInstrumentStore, splitInstrument } from './instrument';
import type { TabKind, TabState } from '../../../shared/browser';

/**
 * Friendly, human-facing label for each instrument kind — what the user reads
 * in the stage header instead of the raw camelCase `TabKind` id (so
 * `sourceControl` reads "Source Control", not "sourceControl"). Keyed by every
 * `TabKind` so adding a kind to the union forces a label key here too.
 */
const KIND_LABEL_KEYS: Record<TabKind, TranslationKey> = {
  web: 'workGraph.instrument.kind.web',
  home: 'workGraph.instrument.kind.home',
  terminal: 'workGraph.instrument.kind.terminal',
  editor: 'workGraph.instrument.kind.editor',
  settings: 'workGraph.instrument.kind.settings',
  agent: 'agent.card.title',
  plugin: 'workGraph.instrument.kind.plugin',
  devtools: 'workGraph.instrument.kind.devtools',
  files: 'workGraph.instrument.kind.files',
  search: 'workGraph.instrument.kind.search',
  sourceControl: 'activity.sourceControl',
};

/** The tools offered in the "Split with…" menu — the live surfaces worth pairing. */
const SPLIT_OPTIONS: readonly TabKind[] = ['web', 'terminal', 'agent', 'editor'];

/**
 * The tab's identity to show beside the kind label: which file / page / origin
 * the instrument is hosting. Web tabs prefer the page host (origin).
 */
function instrumentIdentity(kind: TabKind, tab: TabState | undefined): string {
  if (!tab) return '';
  if (kind === 'web' && tab.url) {
    try {
      return new URL(tab.url).host || tab.title;
    } catch {
      return tab.title;
    }
  }
  // An unnamed tab still carries the registry's default title (e.g. "Terminal",
  // "Settings"), which equals the kind label — showing it just repeats the chip,
  // and in another locale it reads as a redundant mix ("터미널 Terminal"). Treat
  // the untouched default as "no custom identity" so only the localized kind shows.
  if (tab.title === tabKinds[kind].title) return '';
  return tab.title;
}

/** One pane of a split: a thin label header (+ optional close) over the tool surface. */
function Pane({
  tabId,
  kind,
  label,
  grow,
  onClose,
  closeLabel,
}: {
  tabId: string;
  kind: TabKind;
  label: string;
  grow: number;
  onClose?: () => void;
  closeLabel?: string;
}) {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === tabId));
  return (
    <div className="min-w-0 min-h-0 flex flex-col" style={{ flexGrow: grow, flexBasis: 0, flexShrink: 1 }}>
      <div className="h-6 shrink-0 flex items-center gap-1 px-2 border-b border-subtle bg-surface-2 text-caption text-fg-tertiary">
        <span className="truncate" title={label}>{label}</span>
        {onClose ? (
          <button
            type="button"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
            className="ml-auto grid size-4 place-items-center rounded text-fg-tertiary hover:bg-surface-3 hover:text-fg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors duration-fast"
          >
            <X size={11} />
          </button>
        ) : (
          <span className="ml-auto" />
        )}
      </div>
      <div className="flex-1 min-h-0 min-w-0 flex">{tabKinds[kind].render(tabId, tab)}</div>
    </div>
  );
}

/**
 * Toggle the Workbench between coexisting beside the canvas and filling the stage
 * (a tool-focus mode that hides the task map). The canvas is never destroyed — it
 * returns the moment you restore.
 */
function MaximizeToggle() {
  const { t } = useI18n();
  const maximized = useInstrumentStore((s) => s.maximized);
  const setMaximized = useInstrumentStore((s) => s.setMaximized);
  const label = maximized ? t('workGraph.workbench.restore') : t('workGraph.workbench.maximize');
  return (
    <button
      type="button"
      onClick={() => setMaximized(!maximized)}
      aria-label={label}
      title={label}
      aria-pressed={maximized}
      className="grid size-7 place-items-center rounded text-fg-secondary hover:bg-surface-3 hover:text-fg-primary transition-colors duration-fast active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
    </button>
  );
}

/** The "Split with…" dropdown — pick a second tool to host beside the primary. */
function SplitMenu() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        title={t('workGraph.instrument.split')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-caption font-medium text-fg-secondary hover:bg-surface-3 hover:text-fg-primary transition-colors duration-fast active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <SplitSquareHorizontal size={13} />
        {t('workGraph.instrument.split')}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 min-w-[11rem] rounded-md chrome-panel py-1 shadow-card animate-scale-in"
        >
          {SPLIT_OPTIONS.map((k) => (
            <button
              key={k}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void splitInstrument(k);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-body-sm text-fg-secondary hover:bg-surface-3 hover:text-fg-primary focus-visible:outline-none focus-visible:bg-surface-3 transition-colors duration-fast"
            >
              {t(KIND_LABEL_KEYS[k])}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Workbench tab strip — one chip per open tool tab in the featured workspace.
 * Click a chip to switch (features it without closing the others); the × closes
 * just that tab. The featured chip carries the stage's source-of-truth
 * `instrument-kind` testid so "which tool is showing" stays assertable.
 */
function TabStrip() {
  const { t } = useI18n();
  const featuredId = useInstrumentStore((s) => s.tabId);
  const secondaryId = useInstrumentStore((s) => s.secondaryTabId);
  const feature = useInstrumentStore((s) => s.feature);
  const tabs = useTabsStore((s) => s.tabs);
  const closeTab = useTabsStore((s) => s.closeTab);
  const wsId = tabs.find((tb) => tb.id === featuredId)?.workspaceId;
  // The 'home' tab (the legacy launcher dashboard, auto-created at boot) is not a
  // tool — in Mission Control the Task graph IS the home, so a stray "Home New Tab"
  // chip in the Workbench strip is just confusing clutter. Hide it from the strip
  // (unless it is somehow the featured tab, so its chip + close affordance survive).
  const strip = tabs.filter(
    (tb) => tb.workspaceId === wsId && (tb.kind !== 'home' || tb.id === featuredId),
  );
  return (
    <div
      role="tablist"
      aria-label={t('workGraph.workbench.tabs')}
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {strip.map((tb) => {
        const featured = tb.id === featuredId;
        const secondary = tb.id === secondaryId;
        const kindLabel = t(KIND_LABEL_KEYS[tb.kind]);
        const identity = instrumentIdentity(tb.kind, tb);
        const showId = identity.length > 0 && identity !== kindLabel;
        return (
          <div
            key={tb.id}
            role="tab"
            aria-selected={featured}
            className={cn(
              'group flex h-6 shrink-0 items-center gap-1 rounded-md border pl-2 pr-1 text-caption transition-colors duration-fast',
              featured
                ? 'border-default bg-surface-3 text-fg-primary'
                : secondary
                  ? 'border-subtle bg-surface-2 text-fg-secondary'
                  : 'border-transparent text-fg-tertiary hover:bg-surface-2 hover:text-fg-secondary',
            )}
          >
            <button
              type="button"
              onClick={() => feature(tb.id, tb.kind)}
              title={showId ? `${kindLabel} · ${identity}` : kindLabel}
              className="flex min-w-0 items-center gap-1 focus-visible:outline-none"
            >
              <span data-testid={featured ? 'instrument-kind' : undefined} className="shrink-0 font-medium">
                {kindLabel}
              </span>
              {showId ? (
                <span className="min-w-0 max-w-[9rem] truncate text-fg-quaternary">{identity}</span>
              ) : null}
            </button>
            <button
              type="button"
              aria-label={t('workGraph.workbench.closeTab')}
              title={t('workGraph.workbench.closeTab')}
              onClick={() => void closeTab(tb.id)}
              className="grid size-4 shrink-0 place-items-center rounded text-fg-tertiary opacity-0 transition-[opacity,color] duration-fast hover:bg-surface-3 hover:text-fg-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100"
            >
              <X size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The Workbench surface that docks beside the canvas when a Task summons a tool.
 * A TAB STRIP hosts every open tool; the featured one fills the pane (or — once
 * split — two tile side by side, each a real surface from the tab registry, web
 * panes self-reporting their rect). "← Graph" closes the whole Workbench back to
 * the pure canvas.
 */
export function InstrumentStage() {
  const { t } = useI18n();
  const tabId = useInstrumentStore((s) => s.tabId);
  const kind = useInstrumentStore((s) => s.kind);
  const secondaryTabId = useInstrumentStore((s) => s.secondaryTabId);
  const secondaryKind = useInstrumentStore((s) => s.secondaryKind);
  const splitDir = useInstrumentStore((s) => s.splitDir);
  const splitRatio = useInstrumentStore((s) => s.splitRatio);
  const close = useInstrumentStore((s) => s.close);
  const closeSplit = useInstrumentStore((s) => s.closeSplit);
  const setSplitRatio = useInstrumentStore((s) => s.setSplitRatio);
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === tabId));
  const splitRef = useRef<HTMLDivElement>(null);

  if (!tabId || !kind) return null;

  const kindLabel = t(KIND_LABEL_KEYS[kind]);
  const isSplit = secondaryTabId !== null && secondaryKind !== null;
  const row = splitDir === 'row';

  const onDividerDown = (e: ReactPointerEvent): void => {
    e.preventDefault();
    const move = (ev: PointerEvent): void => {
      const el = splitRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const frac = row ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      setSplitRatio(frac);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div data-stage="instrument" className="flex-1 min-w-0 min-h-0 flex flex-col bg-surface-page">
      {/* relative z-30: the glass tab bar is a backdrop-filter stacking context;
          without lifting it above the stage content below, its overflowing
          dropdowns (Split / More / tab overflow) get painted under the
          instrument and become unclickable. */}
      <div className="chrome-header relative z-30 h-8 shrink-0 flex items-center gap-1.5 px-2">
        <TabStrip />
        {!isSplit ? <SplitMenu /> : null}
        <MaximizeToggle />
        <button
          type="button"
          onClick={close}
          title={t('workGraph.stage.backToGraphTitle')}
          className="inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-caption font-medium text-fg-secondary hover:bg-surface-3 hover:text-fg-primary transition-colors duration-fast active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ArrowLeft size={13} />
          {t('workGraph.stage.backToGraph')}
        </button>
      </div>
      {isSplit ? (
        <div ref={splitRef} className={cn('flex-1 min-h-0 min-w-0 flex', row ? 'flex-row' : 'flex-col')}>
          <Pane tabId={tabId} kind={kind} label={kindLabel} grow={splitRatio} />
          <div
            role="separator"
            aria-orientation={row ? 'vertical' : 'horizontal'}
            aria-label={t('workGraph.instrument.resizeSplit')}
            onPointerDown={onDividerDown}
            className={cn(
              'relative shrink-0 z-10 bg-subtle hover:bg-accent transition-colors duration-fast',
              row ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
            )}
          >
            <span aria-hidden className={cn('absolute', row ? '-inset-x-1 inset-y-0' : '-inset-y-1 inset-x-0')} />
          </div>
          <Pane
            tabId={secondaryTabId}
            kind={secondaryKind}
            label={t(KIND_LABEL_KEYS[secondaryKind])}
            grow={1 - splitRatio}
            onClose={closeSplit}
            closeLabel={t('workGraph.instrument.closePane')}
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">{tabKinds[kind].render(tabId, tab)}</div>
      )}
    </div>
  );
}
