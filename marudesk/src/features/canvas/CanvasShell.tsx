import { type ReactNode } from 'react';
import { Code2, Globe, LayoutGrid, Sparkles, SquareTerminal } from 'lucide-react';
import { cn } from '../../lib/cn';
import { WindowControls } from '../../components/WindowControls';
import { useTabEvents } from '../tabs/useTabEvents';
import { useTabsStore } from '../tabs/store';
import type { TabKind } from '../../../shared/browser';
import { CanvasStage } from './CanvasStage';
import logoUrl from '../../assets/logo-mark.png';

/**
 * Full-window shell for the infinite-canvas route (`#/canvas`). Kept separate
 * from the classic `Shell` during the Maru rollout (Phase 2A): it owns the same
 * tab-event bridge so the canvas reflects the live tab set, but renders the
 * canvas instead of the tab strip + split grid. Phase 2C promotes this to the
 * default surface. See docs/maru-identity-and-canvas-design.md.
 */
export function CanvasShell() {
  // Same main→renderer bridge the classic shell mounts, so `useTabsStore` fills
  // with the live tabs (and the canvas store places them as cards).
  useTabEvents();

  const newCard = (kind: TabKind) => {
    void useTabsStore.getState().newTab(kind);
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-surface-page text-fg-primary">
      {/* Frameless-window chrome. The strip is the drag region; controls opt out. */}
      <div
        className="drag-region flex h-10 shrink-0 items-stretch border-b border-subtle bg-surface-1"
        role="banner"
      >
        <div className="flex items-center gap-2 pl-3 pr-2">
          <img src={logoUrl} alt="" aria-hidden draggable={false} className="size-6 select-none" />
          <span className="font-display text-body font-semibold tracking-tight">Maru</span>
        </div>

        <div className="no-drag flex items-center gap-0.5 pl-2">
          <NewCardButton label="New browser" onClick={() => newCard('web')}>
            <Globe size={15} />
          </NewCardButton>
          <NewCardButton label="New editor" onClick={() => newCard('editor')}>
            <Code2 size={15} />
          </NewCardButton>
          <NewCardButton label="New terminal" onClick={() => newCard('terminal')}>
            <SquareTerminal size={15} />
          </NewCardButton>
          <NewCardButton label="New AI chat" onClick={() => newCard('agent')}>
            <Sparkles size={15} />
          </NewCardButton>
        </div>

        <div className="drag-region flex-1 min-w-0" aria-hidden />

        <button
          type="button"
          className="no-drag mr-1 inline-flex items-center gap-1.5 self-center rounded px-2.5 py-1 text-caption text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
          onClick={() => {
            window.location.hash = '/';
          }}
          title="Switch to the classic tabbed view"
        >
          <LayoutGrid size={14} />
          Classic view
        </button>
        <WindowControls />
      </div>

      <div className="relative min-h-0 flex-1">
        <CanvasStage />
      </div>
    </div>
  );
}

function NewCardButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid h-7 w-7 place-items-center rounded',
        'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
      )}
    >
      {children}
    </button>
  );
}
