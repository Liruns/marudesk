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
}

/**
 * Markdown preview pane for the editor. Owns the scrollable container (so split
 * mode can sync it to the editor) and delegates rendering, sanitisation, syntax
 * highlighting, copy buttons, and external-link handling to the shared
 * `<Markdown>` component (which supplies the `.md-prose` host).
 */
export function MarkdownPreview({ content, className, scrollRatio }: MarkdownPreviewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrollRatio === undefined) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    el.scrollTop = scrollRatio * max;
  }, [scrollRatio, content]);

  return (
    <div ref={scrollRef} className={cn('overflow-y-auto', className)}>
      <Markdown source={content} />
    </div>
  );
}
