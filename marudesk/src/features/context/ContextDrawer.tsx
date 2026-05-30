import { CheckSquare, Square, Trash2 } from 'lucide-react';
import { Badge } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useWebPageStore } from '../browser/store';
import { useComposerStore } from '../composer/store';
import { Composer } from '../composer/Composer';
import { CaptureCard } from './CaptureCard';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Right-hand context panel. Inline (flex sibling) rather than floating so the
 * IDE shell can lay it out alongside the browser stage — VSCode/Cursor pattern,
 * not Chrome's slide-over. Width animates between 0 and 380px when toggled.
 *
 * Content stays mounted while collapsed (just clipped) so the captures and
 * composer state don't reset on every toggle.
 */
export function ContextDrawer({ open, onOpenChange }: Props) {
  const captures = useWebPageStore((s) => s.captures);
  const selectedIds = useWebPageStore((s) => s.selectedCaptureIds);
  const clearCaptures = useWebPageStore((s) => s.clearCaptures);
  const setAllSelected = useWebPageStore((s) => s.setAllSelected);
  const tab = useComposerStore((s) => s.tab);
  const setTab = useComposerStore((s) => s.setTab);

  const selectedCount = (() => {
    let n = 0;
    for (const c of captures) if (selectedIds.has(c.id)) n++;
    return n;
  })();
  const allSelected = captures.length > 0 && selectedCount === captures.length;

  return (
    <aside
      role="complementary"
      aria-label="Context cart"
      aria-hidden={!open}
      className={cn(
        'shrink-0 bg-surface-1 border-l border-subtle overflow-hidden',
        'transition-[width] duration-standard',
      )}
      style={{ width: open ? 380 : 0 }}
    >
      <div className="w-[380px] h-full flex flex-col">
        <header className="h-10 shrink-0 flex items-center justify-between px-3 border-b border-subtle">
          <h2 className="text-body-sm font-medium text-fg-primary">
            Context
          </h2>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close context panel"
            className="text-fg-tertiary hover:text-fg-primary transition-colors duration-fast text-body leading-none"
          >
            ×
          </button>
        </header>

        <nav
          role="tablist"
          aria-label="Context tabs"
          className="shrink-0 flex border-b border-subtle"
        >
          <TabButton
            active={tab === 'captures'}
            onClick={() => setTab('captures')}
            label="Captures"
            count={captures.length}
          />
          <TabButton
            active={tab === 'composer'}
            onClick={() => setTab('composer')}
            label="Composer"
          />
        </nav>

        {tab === 'captures' ? (
          <>
            <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-subtle">
              <div className="flex items-center gap-2 text-caption text-fg-tertiary tabular-nums">
                {captures.length > 0 ? (
                  <>
                    <Badge variant="neutral">
                      {selectedCount}/{captures.length}
                    </Badge>
                    <span>selected</span>
                  </>
                ) : (
                  <span>No captures yet</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {captures.length > 0 ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setAllSelected(!allSelected)}
                      aria-label={
                        allSelected ? 'Deselect all' : 'Select all'
                      }
                      className="text-fg-tertiary hover:text-fg-primary transition-colors duration-fast"
                    >
                      {allSelected ? (
                        <CheckSquare size={14} />
                      ) : (
                        <Square size={14} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={clearCaptures}
                      aria-label="Clear all captures"
                      className="text-fg-tertiary hover:text-fg-primary transition-colors duration-fast"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3">
              {captures.length === 0 ? (
                <div className="text-body-sm text-fg-tertiary p-3">
                  Toggle Inspect, then click any element in the browser to
                  capture it. Captures stack here; checkboxes pick which ones
                  feed the Composer.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {captures.map((c) => (
                    <CaptureCard key={c.id} capture={c} />
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <Composer />
        )}
      </div>
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 h-9 flex items-center justify-center gap-2 text-body-sm transition-colors duration-fast',
        active
          ? 'text-fg-primary border-b border-accent -mb-px'
          : 'text-fg-tertiary hover:text-fg-secondary',
      )}
    >
      <span>{label}</span>
      {typeof count === 'number' && count > 0 ? (
        <span className="rounded-pill bg-surface-2 text-fg-secondary px-1.5 text-caption tabular-nums">
          {count}
        </span>
      ) : null}
    </button>
  );
}
