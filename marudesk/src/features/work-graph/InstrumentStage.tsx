import { ArrowLeft } from 'lucide-react';
import { tabKinds } from '../tabs/registry';
import { useInstrumentStore } from './instrument';

/**
 * The full-bleed instrument surface that fills Mission Control's main area when a
 * Task has summoned a tool (browser / editor / terminal). It renders the tab
 * registry surface for the instrument's kind — `web` resolves to BrowserCanvas,
 * which reports its container rect so the live WebContentsView paints over it.
 * The "← Graph" affordance returns to the Task graph home.
 */
export function InstrumentStage() {
  const tabId = useInstrumentStore((s) => s.tabId);
  const kind = useInstrumentStore((s) => s.kind);
  const close = useInstrumentStore((s) => s.close);
  if (!tabId || !kind) return null;

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-surface-page">
      <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-subtle bg-surface-1">
        <button
          type="button"
          onClick={close}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-caption font-medium text-fg-secondary hover:bg-surface-3 hover:text-fg-primary transition-colors duration-fast active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ArrowLeft size={13} />
          Graph
        </button>
        <span className="text-caption text-fg-tertiary">Instrument · {kind}</span>
      </div>
      <div className="flex-1 min-h-0 flex">{tabKinds[kind].render(tabId)}</div>
    </div>
  );
}
