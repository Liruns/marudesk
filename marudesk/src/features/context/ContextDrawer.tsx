import { useState } from 'react';
import { CheckSquare, History, Maximize2, Square, Trash2 } from 'lucide-react';
import { Badge } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { useWebPageStore } from '../browser/store';
import { useComposerStore } from '../composer/store';
import { AgentChat } from '../agent/AgentChat';
import { SessionList } from '../agent/SessionList';
import { openAgentTab } from '../agent/store';
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
  const { t } = useI18n();
  const captures = useWebPageStore((s) => s.captures);
  const selectedIds = useWebPageStore((s) => s.selectedCaptureIds);
  const clearCaptures = useWebPageStore((s) => s.clearCaptures);
  const setAllSelected = useWebPageStore((s) => s.setAllSelected);
  const tab = useComposerStore((s) => s.tab);
  const setTab = useComposerStore((s) => s.setTab);
  const [showHistory, setShowHistory] = useState(false);

  const selectedCount = (() => {
    let n = 0;
    for (const c of captures) if (selectedIds.has(c.id)) n++;
    return n;
  })();
  const allSelected = captures.length > 0 && selectedCount === captures.length;

  return (
    <aside
      role="complementary"
      aria-label={t('context.drawer.label')}
      aria-hidden={!open}
      className={cn(
        'shrink-0 bg-surface-1 border-l border-subtle overflow-hidden',
        'transition-[width] duration-standard',
      )}
      style={{ width: open ? 380 : 0 }}
    >
      <div className="relative w-[380px] h-full flex flex-col">
        <header className="h-10 shrink-0 flex items-center justify-between px-3 border-b border-subtle">
          <h2 className="text-body-sm font-medium text-fg-primary">{t('context.drawer.title')}</h2>
          <div className="flex items-center gap-2">
            {tab === 'agent' ? (
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                aria-label={t('context.drawer.history')}
                title={t('context.drawer.history')}
                className={cn(
                  'transition-colors duration-fast',
                  showHistory ? 'text-fg-primary' : 'text-fg-tertiary hover:text-fg-primary',
                )}
              >
                <History size={13} />
              </button>
            ) : null}
            {tab === 'agent' ? (
              <button
                type="button"
                onClick={() => void openAgentTab()}
                aria-label={t('context.drawer.openChatTab')}
                title={t('context.drawer.openChatTab')}
                className="text-fg-tertiary hover:text-fg-primary transition-colors duration-fast"
              >
                <Maximize2 size={13} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label={t('context.drawer.close')}
              className="text-fg-tertiary hover:text-fg-primary transition-colors duration-fast text-body leading-none"
            >
              ×
            </button>
          </div>
        </header>

        <nav
          role="tablist"
          aria-label={t('context.tabs.label')}
          className="shrink-0 flex border-b border-subtle"
        >
          <TabButton active={tab === 'agent'} onClick={() => setTab('agent')} label={t('context.tabs.agent')} />
          <TabButton
            active={tab === 'captures'}
            onClick={() => setTab('captures')}
            label={t('context.tabs.captures')}
            count={captures.length}
          />
        </nav>

        {tab === 'agent' ? (
          <AgentChat />
        ) : (
          <>
            <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-subtle">
              <div className="flex items-center gap-2 text-caption text-fg-tertiary tabular-nums">
                {captures.length > 0 ? (
                  <>
                    <Badge variant="neutral">
                      {selectedCount}/{captures.length}
                    </Badge>
                    <span>{t('context.drawer.selected')}</span>
                  </>
                ) : (
                  <span>{t('context.drawer.noCaptures')}</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {captures.length > 0 ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setAllSelected(!allSelected)}
                      aria-label={t(
                        allSelected ? 'context.drawer.deselectAll' : 'context.drawer.selectAll',
                      )}
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
                      aria-label={t('context.drawer.clearAll')}
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
                  {t('context.drawer.empty')}
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
        )}
        {showHistory && tab === 'agent' ? (
          <div className="absolute inset-0 z-20 flex flex-col bg-surface-1">
            <header className="h-10 shrink-0 flex items-center justify-between px-3 border-b border-subtle">
              <h2 className="text-body-sm font-medium text-fg-primary">{t('context.drawer.history')}</h2>
              <button
                type="button"
                onClick={() => setShowHistory(false)}
                aria-label={t('context.drawer.closeHistory')}
                className="text-fg-tertiary hover:text-fg-primary transition-colors duration-fast text-body leading-none"
              >
                ×
              </button>
            </header>
            <SessionList className="flex-1" onPick={() => setShowHistory(false)} />
          </div>
        ) : null}
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
