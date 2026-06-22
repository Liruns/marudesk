import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, SplitSquareHorizontal, X } from 'lucide-react';
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
 * The full-bleed instrument surface that fills Mission Control's main area when a
 * Task summons a tool. Hosts ONE tool, or — once split — two side by side (e.g. an
 * editor beside the running app / a Preview), each a real tool surface from the tab
 * registry. Web panes self-report their rect, so two live WebContentsViews tile
 * their panes via the existing bounds pipeline. "← Graph" returns to the home.
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
  const identity = instrumentIdentity(kind, tab);
  const showIdentity = identity.length > 0 && identity !== kindLabel;
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
      <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-subtle bg-surface-1">
        <button
          type="button"
          onClick={close}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-caption font-medium text-fg-secondary hover:bg-surface-3 hover:text-fg-primary transition-colors duration-fast active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ArrowLeft size={13} />
          {t('workGraph.stage.backToGraph')}
        </button>
        <span data-testid="instrument-kind" className="text-caption text-fg-tertiary">{kindLabel}</span>
        {showIdentity ? (
          <span className="min-w-0 truncate text-caption text-fg-tertiary" title={identity}>· {identity}</span>
        ) : null}
        <span className="ml-auto" />
        {!isSplit ? <SplitMenu /> : null}
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
