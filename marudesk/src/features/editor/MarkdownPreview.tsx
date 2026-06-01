import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { cn } from '../../lib/cn';

/** Configure marked once: synchronous, GitHub-flavored-ish. */
marked.setOptions({ async: false, breaks: false, gfm: true });

function renderMarkdown(source: string): string {
  const raw = marked(source) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
  });
}

function handleLinks(e: React.MouseEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  const anchor = target.closest('a');
  if (!anchor) return;
  e.preventDefault();
  const href = anchor.getAttribute('href');
  if (href) window.open(href, '_blank', 'noopener,noreferrer');
}

interface MarkdownPreviewProps {
  content: string;
  className?: string;
}

export function MarkdownPreview({ content, className }: MarkdownPreviewProps) {
  const html = useMemo(() => renderMarkdown(content), [content]);

  return (
    <div
      className={cn('overflow-y-auto', className)}
      onClick={handleLinks}
      // biome-ignore lint: preview pane intentionally renders sanitized HTML
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
