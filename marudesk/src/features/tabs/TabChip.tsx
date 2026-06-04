import { type MouseEvent } from 'react';
import { X } from 'lucide-react';
import type { TabState } from '../../../shared/browser';
import { cn } from '../../lib/cn';
import { isDirty, useEditorStore } from '../editor/store';
import { TabIndicator } from './TabIndicator';

const TAB_DND_MIME = 'application/x-marudesk-tab';

export type TabChipLabels = {
  readonly agentNeedsInput: string;
  readonly closeTab: string;
  readonly newTabFallback: string;
  readonly unsavedChangesCloseTab: string;
  readonly unsavedCloseTab: string;
};

type TabChipProps = {
  readonly tab: TabState;
  readonly active: boolean;
  readonly attention?: boolean;
  readonly grouped?: boolean;
  readonly pinned?: boolean;
  readonly onActivate: () => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onClose: () => void;
  readonly canClose: boolean;
  readonly dragging: boolean;
  readonly dropTarget: boolean;
  readonly labels: TabChipLabels;
  readonly onDragStart: () => void;
  readonly onDragEnter: () => void;
  readonly onDrop: () => void;
  readonly onDragEnd: () => void;
};

export function TabChip({
  tab,
  active,
  attention,
  grouped,
  pinned,
  onActivate,
  onContextMenu,
  onClose,
  canClose,
  dragging,
  dropTarget,
  labels,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
}: TabChipProps) {
  const label = tab.title.trim() || prettyUrl(tab.url) || labels.newTabFallback;
  const dirty = useEditorStore((s) =>
    tab.kind === 'editor' && tab.filePath
      ? isDirty(s.files[tab.filePath])
      : false,
  );
  const onCloseClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onClose();
  };
  const onMiddleDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button === 1 && canClose) {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-active={active}
      draggable
      onClick={onActivate}
      onMouseDown={onMiddleDown}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(TAB_DND_MIME, tab.id);
        onDragStart();
      }}
      onDragEnter={onDragEnter}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TAB_DND_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(TAB_DND_MIME)) return;
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      title={tab.url || label}
      className={cn(
        'group relative flex items-center rounded-md',
        'text-caption cursor-default select-none transition-colors duration-fast',
        pinned
          ? 'h-8 w-9 shrink-0 justify-center'
          : grouped
            ? 'h-7 grow-0 basis-[170px] min-w-[64px] gap-2 pl-3 pr-1.5'
            : 'h-8 flex-1 basis-0 min-w-[80px] max-w-[240px] gap-2 pl-3 pr-1.5',
        active
          ? grouped
            ? 'bg-surface-3 text-fg-primary'
            : 'bg-surface-2 text-fg-primary'
          : grouped
            ? 'bg-transparent text-fg-secondary hover:text-fg-primary hover:bg-surface-3/50'
            : 'bg-transparent text-fg-secondary hover:text-fg-primary hover:bg-surface-2/50',
        dragging ? 'opacity-40' : '',
      )}
    >
      {dropTarget ? (
        <span
          aria-hidden
          className="absolute -left-1 top-1 bottom-1 w-0.5 rounded-pill bg-accent"
        />
      ) : null}
      {pinned ? (
        <span className="relative flex items-center justify-center">
          <TabIndicator tab={tab} />
          {attention ? (
            <span
              aria-hidden
              title={labels.agentNeedsInput}
              className="absolute -top-1.5 -right-1.5 size-1.5 rounded-pill bg-warning animate-pulse"
            />
          ) : null}
        </span>
      ) : (
        <>
          <TabIndicator tab={tab} />
          <span className="flex-1 min-w-0 truncate font-medium">{label}</span>
          {attention ? (
            <span
              aria-hidden
              title={labels.agentNeedsInput}
              className="size-1.5 rounded-pill bg-warning animate-pulse shrink-0"
            />
          ) : null}
          {canClose ? (
            <button
              type="button"
              onClick={onCloseClick}
              aria-label={dirty ? labels.unsavedCloseTab : labels.closeTab}
              title={
                dirty ? labels.unsavedChangesCloseTab : labels.closeTab
              }
              className={cn(
                'size-5 rounded flex items-center justify-center shrink-0',
                'text-fg-tertiary hover:bg-surface-3 hover:text-fg-primary',
                dirty || active
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100',
              )}
            >
              {dirty ? (
                <>
                  <span
                    aria-hidden
                    className="size-2 rounded-pill bg-fg-secondary group-hover:hidden"
                  />
                  <X size={12} className="hidden group-hover:block" />
                </>
              ) : (
                <X size={12} />
              )}
            </button>
          ) : dirty ? (
            <span
              className="size-5 shrink-0 flex items-center justify-center"
              aria-hidden
            >
              <span className="size-2 rounded-pill bg-fg-secondary" />
            </span>
          ) : (
            <span className="size-5 shrink-0" aria-hidden />
          )}
        </>
      )}
    </div>
  );
}

function prettyUrl(url: string): string {
  if (!url || url === 'about:blank') return '';
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}
