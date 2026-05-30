import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, MousePointerSquareDashed, Search, Sparkles, X } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import { DomTree } from '../components/DomTree';
import { StylesPane } from '../components/StylesPane';

/** Forceable pseudo-classes (CSS.forcePseudoState), shown as a toggle row. */
const FORCE_STATES = [':hover', ':active', ':focus', ':focus-within', ':visited'];

/**
 * Elements panel: an element picker (CDP `Overlay.setInspectMode`), a DOM search
 * (DOM.performSearch), a force-pseudo-state row, the DOM tree, and the styles
 * inspector beneath it. The picker draws Chromium's native highlight + "click to
 * select" over the page; the selected node flows back through
 * `Overlay.inspectNodeRequested` (handled in the store).
 */
export function ElementsPanel() {
  const picking = useDevtoolsStore((s) => s.picking);
  const selectedId = useDevtoolsStore((s) => s.selectedId);
  const windowMode = useDevtoolsStore((s) => s.windowMode);
  const forcedStates = useDevtoolsStore((s) => s.forcedStates);
  const searchCount = useDevtoolsStore((s) => s.searchCount);
  const searchIndex = useDevtoolsStore((s) => s.searchIndex);
  const [searchInput, setSearchInput] = useState('');

  // Esc cancels picking, matching the page-side inspect overlay.
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void useDevtoolsStore.getState().stopPick();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking]);

  const runSearch = () => void useDevtoolsStore.getState().searchDom(searchInput);
  const clearSearch = () => {
    setSearchInput('');
    useDevtoolsStore.getState().clearSearch();
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 h-8 flex items-center px-1.5 border-b border-subtle gap-1">
        <button
          type="button"
          aria-pressed={picking}
          aria-label="Pick an element"
          title="Select an element in the page"
          onClick={() => {
            const s = useDevtoolsStore.getState();
            if (s.picking) void s.stopPick();
            else void s.startPick();
          }}
          className={cn(
            'size-6 rounded flex items-center justify-center transition-colors duration-fast',
            picking
              ? 'text-accent bg-accent-subtle/50'
              : 'text-fg-tertiary hover:text-fg-primary hover:bg-surface-2',
          )}
        >
          <MousePointerSquareDashed size={15} />
        </button>
        {windowMode ? null : (
          <button
            type="button"
            aria-label="Add to AI context"
            title="Add the selected element (with outerHTML + computed style) to the composer context"
            disabled={selectedId === null}
            onClick={() => void useDevtoolsStore.getState().captureSelected()}
            className={cn(
              'size-6 rounded flex items-center justify-center transition-colors duration-fast',
              selectedId === null
                ? 'text-fg-tertiary/40 cursor-not-allowed'
                : 'text-fg-tertiary hover:text-fg-primary hover:bg-surface-2',
            )}
          >
            <Sparkles size={15} />
          </button>
        )}
        <div className="flex-1" />
        {/* DOM search: Enter runs / steps forward, Shift+Enter steps back. */}
        <div className="flex items-center gap-0.5">
          <div className="relative">
            <Search
              size={12}
              className="absolute left-1.5 top-1/2 -translate-y-1/2 text-fg-tertiary pointer-events-none"
            />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (useDevtoolsStore.getState().searchCount > 0 && searchInput.trim()) {
                    void useDevtoolsStore.getState().stepSearch(e.shiftKey ? -1 : 1);
                  } else {
                    runSearch();
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  clearSearch();
                }
              }}
              spellCheck={false}
              autoComplete="off"
              placeholder="Find (text/selector)"
              aria-label="Search the DOM"
              className="h-6 w-36 min-w-0 rounded bg-surface-2 pl-6 pr-2 text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-accent/50"
            />
          </div>
          {searchCount > 0 ? (
            <>
              <span className="text-caption text-fg-tertiary tabular-nums px-0.5">
                {searchIndex + 1}/{searchCount}
              </span>
              <button
                type="button"
                aria-label="Previous match"
                onClick={() => void useDevtoolsStore.getState().stepSearch(-1)}
                className="size-5 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
              >
                <ChevronUp size={13} />
              </button>
              <button
                type="button"
                aria-label="Next match"
                onClick={() => void useDevtoolsStore.getState().stepSearch(1)}
                className="size-5 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
              >
                <ChevronDown size={13} />
              </button>
              <button
                type="button"
                aria-label="Clear search"
                onClick={clearSearch}
                className="size-5 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
              >
                <X size={13} />
              </button>
            </>
          ) : null}
        </div>
      </div>

      {/* Force element states (CSS.forcePseudoState) — needs a selected node. */}
      <div className="shrink-0 flex items-center gap-1 px-1.5 py-1 border-b border-subtle flex-wrap">
        <span className="text-caption text-fg-tertiary mr-0.5">:force</span>
        {FORCE_STATES.map((ps) => {
          const on = forcedStates.has(ps);
          return (
            <button
              key={ps}
              type="button"
              aria-pressed={on}
              disabled={selectedId === null}
              onClick={() => void useDevtoolsStore.getState().toggleForcedState(ps)}
              className={cn(
                'h-5 px-1.5 rounded text-caption font-mono transition-colors duration-fast',
                selectedId === null
                  ? 'text-fg-tertiary/40 cursor-not-allowed'
                  : on
                    ? 'bg-accent-subtle/60 text-accent'
                    : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
              )}
            >
              {ps}
            </button>
          );
        })}
      </div>

      <div className="flex-[3] min-h-0 border-b border-subtle">
        <DomTree />
      </div>
      <div className="flex-[2] min-h-0">
        <StylesPane />
      </div>
    </div>
  );
}
