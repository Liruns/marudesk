import { ArrowLeft } from 'lucide-react';
import { tabKinds } from '../tabs/registry';
import { useTabsStore } from '../tabs/store';
import { useI18n } from '../../i18n/useI18n';
import type { TranslationKey } from '../../i18n/messages';
import { useInstrumentStore } from './instrument';
import type { TabKind, TabState } from '../../../shared/browser';

/**
 * Friendly, human-facing label for each instrument kind — what the user reads
 * in the stage header instead of the raw camelCase `TabKind` id (so
 * `sourceControl` reads "Source Control", not "sourceControl"). Keyed by every
 * `TabKind` so adding a kind to the union forces a label key here too. The
 * `agent` / `sourceControl` kinds reuse existing translations; the rest have
 * dedicated `workGraph.instrument.kind.*` keys resolved via `t()` at render.
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

/**
 * The tab's identity to show beside the kind label: which file / page / origin
 * the full-area instrument is actually hosting. Web tabs prefer the page host
 * (origin) so the user reads `example.com` rather than a long title; other kinds
 * fall back to the tab title.
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

/**
 * The full-bleed instrument surface that fills Mission Control's main area when a
 * Task has summoned a tool (browser / editor / terminal). It renders the tab
 * registry surface for the instrument's kind — `web` resolves to BrowserCanvas,
 * which reports its container rect so the live WebContentsView paints over it.
 * The "← Graph" affordance returns to the Task graph home.
 */
export function InstrumentStage() {
  const { t } = useI18n();
  const tabId = useInstrumentStore((s) => s.tabId);
  const kind = useInstrumentStore((s) => s.kind);
  const close = useInstrumentStore((s) => s.close);
  // Resolve the tab so kind renderers that need it (agent → workspaceId, devtools
  // → target tab) get it, matching the grid/strip dispatch.
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === tabId));
  if (!tabId || !kind) return null;

  const identity = instrumentIdentity(kind, tab);

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
        <span data-testid="instrument-kind" className="text-caption text-fg-tertiary">{t(KIND_LABEL_KEYS[kind])}</span>
        {identity ? (
          <span className="min-w-0 truncate text-caption text-fg-tertiary">· {identity}</span>
        ) : null}
      </div>
      <div className="flex-1 min-h-0 flex">{tabKinds[kind].render(tabId, tab)}</div>
    </div>
  );
}
