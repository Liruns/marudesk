import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';

/**
 * Minimal single-field modal used for naming/renaming a workspace. Electron
 * disables `window.prompt`, so the deck rolls its own portaled dialog. It hides
 * the embedded browser view while open (a WebContentsView composites above the
 * React DOM) and restores it on close, mirroring {@link ContextMenu}.
 */
export function NameDialog({
  title,
  confirmLabel,
  initialValue = '',
  placeholder,
  allowEmpty = false,
  onSubmit,
  onClose,
}: {
  title: string;
  confirmLabel: string;
  initialValue?: string;
  placeholder?: string;
  /** When set, an empty value is allowed (e.g. create defaults to the folder name). */
  allowEmpty?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    void window.marudesk.invoke('browser:set-visible', false);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      void window.marudesk.invoke('browser:set-visible', true);
    };
  }, [onClose]);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed && !allowEmpty) return;
    onSubmit(trimmed);
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        className="w-[360px] rounded-lg bg-surface-1 border border-default shadow-lifted p-4 flex flex-col gap-3"
      >
        <h2 className="text-body font-semibold text-fg-primary">{title}</h2>
        <input
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          className={cn(
            'h-9 rounded-md bg-surface-2 border border-subtle px-3',
            'text-body-sm text-fg-primary placeholder:text-fg-tertiary',
            'focus:outline-none focus:border-accent',
          )}
        />
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded-md text-body-sm text-fg-secondary hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!allowEmpty && !value.trim()}
            className={cn(
              'h-8 px-3 rounded-md text-body-sm font-medium bg-accent text-white',
              'transition-opacity duration-fast hover:opacity-90',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
