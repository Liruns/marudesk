import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { toMessage } from '../../lib/toMessage';

/**
 * One clipboard button with a brief "copied" check-mark, shared across the app
 * (message prose, reachable URLs, tool output) so the copy UX — icon swap,
 * confirmation timing, and failure toast — stays consistent in one place.
 *
 * `write` overrides the default `navigator.clipboard.writeText` for surfaces
 * that must route through the main process (the desktop shell uses the
 * `clipboard:write-text` IPC bridge, where `navigator.clipboard` is unreliable).
 */
export type CopyButtonProps = {
  text: string;
  label?: string;
  /** `sm` for inline affordances (messages); `md` for standalone rows. */
  size?: 'sm' | 'md';
  /** Override the clipboard write (e.g. the main window's IPC bridge). */
  write?: (text: string) => Promise<unknown>;
  className?: string;
};

const SIZES = {
  sm: { box: 'size-5', icon: 12, check: 'text-accent', ms: 1200 },
  md: { box: 'size-7', icon: 14, check: 'text-success', ms: 1500 },
} as const;

export function CopyButton({
  text,
  label = 'Copy',
  size = 'sm',
  write,
  className,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const spec = SIZES[size];
  const copy = async (): Promise<void> => {
    try {
      await (write ? write(text) : navigator.clipboard.writeText(text));
      setCopied(true);
      window.setTimeout(() => setCopied(false), spec.ms);
    } catch (err) {
      toast({ title: 'Copy failed', description: toMessage(err), variant: 'error' });
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded text-fg-tertiary',
        'transition-colors duration-fast hover:bg-surface-2 hover:text-fg-primary',
        spec.box,
        className,
      )}
    >
      {copied ? (
        <Check size={spec.icon} className={spec.check} />
      ) : (
        <Copy size={spec.icon} />
      )}
    </button>
  );
}
