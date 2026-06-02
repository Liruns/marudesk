import type { MouseEvent } from 'react';
import { TabStrip } from '../features/tabs/TabStrip';
import { WindowControls } from './WindowControls';
import logoUrl from '../assets/logo.png';

/**
 * Frameless-window chrome: a single horizontal strip at the very top. The
 * wrapper is the drag region (grab empty space to move the window); interactive
 * children opt out via `.no-drag`.
 *
 * Layout: [logo slot] [tabs ............] [window controls]
 *
 * The logo slot is a 48px column that lines up with the ActivityBar directly
 * below it (same width + a shared right border), so the top-left reads as one
 * continuous vertical rail instead of a floating brand block. On macOS the OS
 * draws the traffic lights top-left, so the slot shifts right to clear them and
 * the rail alignment is dropped there.
 */
export function TitleBar() {
  const isMac =
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Macintosh');

  // Double-click empty chrome → maximize/restore, mirroring a native title bar.
  // Windows/Linux custom frames have no native handler for this; macOS keeps
  // its own via titleBarStyle, but the IPC path is harmless there too. Ignore
  // double-clicks on a tab or control so those keep their own behavior.
  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('[role="tab"], button, input, [data-no-maximize]')) {
      return;
    }
    void window.marudesk.invoke('window:maximize-toggle');
  };

  return (
    <div
      className="drag-region h-10 shrink-0 flex items-stretch bg-surface-1 border-b border-subtle"
      role="banner"
      aria-label="Window chrome"
      onDoubleClick={onDoubleClick}
    >
      {/* Logo slot — reserved for a brand logo (placeholder mark for now). On
          Windows/Linux it's a 48px column aligned with the ActivityBar below
          (shared right border) so the left edge reads as one rail. On macOS it
          shifts right to clear the traffic-light buttons. */}
      {isMac ? (
        <div
          className="flex items-center shrink-0"
          style={{ paddingLeft: 76, paddingRight: 12 }}
        >
          <img src={logoUrl} alt="" aria-hidden draggable={false} className="size-5 select-none" />
        </div>
      ) : (
        <div className="w-12 shrink-0 flex items-center justify-center border-r border-subtle">
          <img src={logoUrl} alt="" aria-hidden draggable={false} className="size-5 select-none" />
        </div>
      )}
      <TabStrip />
      <WindowControls />
    </div>
  );
}
