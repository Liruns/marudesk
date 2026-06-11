import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Touch-first modal sheet anchored to the bottom edge — the mobile stand-in for
 * the desktop's pickers (workspace / sessions / model). Tapping the dimmed
 * backdrop or the close button dismisses it; content scrolls inside the sheet.
 */
export function BottomSheet({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="sheet-overlay" role="presentation" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet__header">
          <div className="sheet__title">{title}</div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
      </div>
    </div>
  );
}
