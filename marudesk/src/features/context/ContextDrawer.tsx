import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CheckSquare, History, Maximize2, Square, Trash2, X } from 'lucide-react';
import { Badge } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { readStoredWidth, writeStoredWidth } from '../../lib/panelWidth';
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

// The context panel is user-resizable (VSCode/Cursor pattern), mirroring the
// Explorer sidebar. Persisted locally so it survives reloads; clamped so it
// can't be dragged uselessly thin or eat the whole window. The default is
// roomy enough that the AI chat composer + model bar don't feel cramped at
// first open.
const DRAWER_MIN = 320;
const DRAWER_MAX = 720;
const DRAWER_DEFAULT = 420;
const DRAWER_WIDTH_KEY = 'marudesk.contextDrawerWidth';

function readDrawerWidth(): number {
  return readStoredWidth(DRAWER_WIDTH_KEY, DRAWER_MIN, DRAWER_MAX, DRAWER_DEFAULT);
}

/**
 * Right-hand context panel. Inline (flex sibling) rather than floating so the
 * IDE shell can lay it out alongside the browser stage — VSCode/Cursor pattern,
 * not Chrome's slide-over. Width animates between 0 and its set width when
 * toggled, and the left edge is draggable to resize (persisted).
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
  const [width, setWidth] = useState(readDrawerWidth);
  const [resizing, setResizing] = useState(false);

  // Drag the LEFT edge to resize (the panel is anchored to the window's right,
  // so dragging left widens it). Pointer capture keeps move events flowing even
  // when the cursor outruns the seam; the stage to the left reflows
  // automatically (its ResizeObserver re-reports web-view bounds to main).
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const asideRight = handle.parentElement?.getBoundingClientRect().right ?? 0;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    let last = width;
    const onMove = (ev: PointerEvent) => {
      last = Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, asideRight - ev.clientX));
      setWidth(last);
    };
    const onDone = () => {
      setResizing(false);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('lostpointercapture', onDone);
      writeStoredWidth(DRAWER_WIDTH_KEY, last);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('lostpointercapture', onDone);
  };

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
        'chrome-panel relative shrink-0 border-y-0 border-r-0 overflow-hidden',
        // No width transition mid-drag — it would lag a frame behind the pointer.
        resizing ? '' : 'transition-[width] duration-standard',
      )}
      style={{ width: open ? width : 0 }}
    >
      {open ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('context.drawer.resize')}
          onPointerDown={onResizeStart}
          className={cn(
            'absolute inset-y-0 left-0 z-30 w-1 cursor-col-resize',
            'transition-colors duration-fast',
            resizing ? 'bg-accent' : 'bg-transparent hover:bg-accent/60',
          )}
        >
          {/* Wider invisible hit area, kept inside the panel (overflow-hidden). */}
          <span aria-hidden className="absolute inset-y-0 left-0 -right-1" />
        </div>
      ) : null}
      <div className="relative h-full flex flex-col" style={{ width }}>
        <header className="chrome-header h-10 shrink-0 flex items-center justify-between px-3">
          <h2 className="text-body-sm font-medium text-fg-primary">{t('context.drawer.title')}</h2>
          <div className="flex items-center gap-0.5">
            {tab === 'agent' ? (
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                aria-label={t('context.drawer.history')}
                title={t('context.drawer.history')}
                aria-pressed={showHistory}
                className={cn(
                  'chrome-icon-button size-6',
                  showHistory
                    ? 'chrome-icon-button-active'
                    : 'text-fg-tertiary',
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
                className="chrome-icon-button size-6"
              >
                <Maximize2 size={13} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label={t('context.drawer.close')}
              className="chrome-icon-button size-6"
            >
              <X size={14} />
            </button>
          </div>
        </header>

        <nav
          role="tablist"
          aria-label={t('context.tabs.label')}
          className="shrink-0 flex border-b border-subtle bg-surface-1/70"
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
            <div className="chrome-header shrink-0 flex items-center justify-between px-4 py-2">
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
                      className="chrome-icon-button size-6"
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
                      className="chrome-icon-button size-6 hover:text-error hover:bg-error-subtle/30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3">
              {captures.length === 0 ? (
                <div className="chrome-panel-strong rounded-lg p-4 text-body-sm text-fg-tertiary">
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
          <div className="chrome-panel absolute inset-0 z-20 flex flex-col rounded-none border-0">
            <header className="chrome-header h-10 shrink-0 flex items-center justify-between px-3">
              <h2 className="text-body-sm font-medium text-fg-primary">{t('context.drawer.history')}</h2>
              <button
                type="button"
                onClick={() => setShowHistory(false)}
                aria-label={t('context.drawer.closeHistory')}
                className="chrome-icon-button size-6"
              >
                <X size={14} />
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
          ? 'text-fg-primary border-b border-accent -mb-px bg-surface-2/50 shadow-highlight'
          : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2/40',
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
