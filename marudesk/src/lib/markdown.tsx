import { useEffect, useMemo, useRef } from 'react';
import { renderMarkdownToHtml } from './markdownToHtml';
import { cn } from './cn';

/** Open link clicks externally instead of navigating the renderer frame. */
function handleLinks(e: React.MouseEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  const anchor = target.closest('a');
  if (!anchor) return;
  e.preventDefault();
  const href = anchor.getAttribute('href');
  if (href) window.open(href, '_blank', 'noopener,noreferrer');
}

const COPY_BTN_ATTR = 'data-md-copy';

/**
 * After the sanitized HTML is mounted, decorate every `<pre>` with a hover copy
 * button (top-right) and, when highlight.js detected a language, a small label.
 * Idempotent per render: we re-run whenever the HTML changes and skip blocks
 * already decorated. Plain DOM (no React portals) keeps this cheap during
 * streaming re-renders.
 */
function decoratePre(root: HTMLElement) {
  const pres = root.querySelectorAll('pre');
  pres.forEach((pre) => {
    if (pre.querySelector(`[${COPY_BTN_ATTR}]`)) return;
    pre.classList.add('md-codeblock');

    const code = pre.querySelector('code');
    const lang = code
      ? Array.from(code.classList)
          .find((c) => c.startsWith('language-'))
          ?.slice('language-'.length)
      : undefined;

    if (lang) {
      const label = document.createElement('span');
      label.className = 'md-code-lang';
      label.textContent = lang;
      pre.appendChild(label);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute(COPY_BTN_ATTR, '');
    btn.className = 'md-copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      const text = code?.textContent ?? pre.textContent ?? '';
      void navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied';
        btn.classList.add('is-copied');
        window.setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('is-copied');
        }, 1200);
      });
    });
    pre.appendChild(btn);
  });
}

interface MarkdownProps {
  source: string;
  className?: string;
}

/**
 * Shared markdown view: renders sanitized GFM + highlighted code into a
 * `.md-prose` container (so the existing prose styles apply), decorates code
 * blocks with copy buttons, and opens links externally. The HTML is memoised by
 * source so streaming chunks only reparse when the text actually changes.
 */
export function Markdown({ source, className }: MarkdownProps) {
  const html = useMemo(() => renderMarkdownToHtml(source), [source]);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (ref.current) decoratePre(ref.current);
  }, [html]);

  return (
    <div
      ref={ref}
      className={cn('md-prose', className)}
      onClick={handleLinks}
      // biome-ignore lint: content is sanitized via renderMarkdownToHtml (DOMPurify)
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
