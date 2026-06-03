import { useEffect, useRef } from 'react';
import { cn } from '../../lib/cn';
import { Markdown } from '../../lib/markdown';

interface MarkdownPreviewProps {
  content: string;
  className?: string;
  /**
   * Target scroll position as a 0..1 fraction of the preview's scrollable
   * height, driven by the editor in split mode. Applied imperatively so we
   * don't rerender on every scroll tick. Omit (or leave undefined) to let the
   * preview scroll freely.
   */
  scrollRatio?: number;
  /**
   * Report the user's own scroll fraction back up (split mode, two-way sync).
   * Suppressed while applying an editor-driven `scrollRatio` so the panes don't
   * ping-pong.
   */
  onScrollRatio?: (ratio: number) => void;
}

/**
 * Markdown preview pane for the editor. Owns the scrollable container (so split
 * mode can sync it to the editor) and delegates rendering, sanitisation, syntax
 * highlighting, copy buttons, and external-link handling to the shared
 * `<Markdown>` component (which supplies the `.md-prose` host).
 */
export function MarkdownPreview({
  content,
  className,
  scrollRatio,
  onScrollRatio,
}: MarkdownPreviewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // True right after we set scrollTop ourselves, so the resulting scroll event
  // isn't reported back to the editor (which would bounce the two panes).
  const applyingRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrollRatio === undefined) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    applyingRef.current = true;
    el.scrollTop = scrollRatio * max;
  }, [scrollRatio, content]);

  const onScroll = () => {
    if (applyingRef.current) {
      applyingRef.current = false;
      return;
    }
    const el = scrollRef.current;
    if (!el || !onScrollRatio) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    onScrollRatio(el.scrollTop / max);
  };

  return (
    <div ref={scrollRef} onScroll={onScroll} className={cn('overflow-y-auto', className)}>
      <Markdown source={content} />
    </div>
  );
}
