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

const DECORATED_ATTR = 'data-md-decorated';

/**
 * Blocks longer than this many lines start collapsed (with a "show all" toggle)
 * so one giant code dump doesn't take over the whole transcript.
 */
const COLLAPSE_LINES = 26;

/**
 * After the sanitized HTML is mounted, decorate every `<pre>` with hover actions
 * (wrap toggle + copy, top-right), a language label when highlight.js detected
 * one, and a collapse toggle for very long blocks. Idempotent per render: we
 * re-run whenever the HTML changes and skip blocks already decorated. Plain DOM
 * (no React portals) keeps this cheap during streaming re-renders. (Streaming
 * replaces the HTML each chunk, so toggle state resets until the turn settles —
 * an accepted trade-off for the stateless decoration.)
 */
function decoratePre(root: HTMLElement) {
  const pres = root.querySelectorAll('pre');
  pres.forEach((pre) => {
    if (pre.hasAttribute(DECORATED_ATTR)) return;
    pre.setAttribute(DECORATED_ATTR, '');
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

    const text = code?.textContent ?? pre.textContent ?? '';

    const actions = document.createElement('span');
    actions.className = 'md-pre-actions';

    // Wrap toggle: long lines wrap in place instead of scrolling sideways —
    // much easier to read in a narrow split pane / drawer.
    const wrapBtn = document.createElement('button');
    wrapBtn.type = 'button';
    wrapBtn.className = 'md-pre-btn';
    wrapBtn.textContent = 'Wrap';
    wrapBtn.addEventListener('click', () => {
      wrapBtn.classList.toggle('is-on', pre.classList.toggle('md-wrap'));
    });
    actions.appendChild(wrapBtn);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'md-pre-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(code?.textContent ?? pre.textContent ?? '').then(() => {
        copyBtn.textContent = 'Copied';
        copyBtn.classList.add('is-copied');
        window.setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('is-copied');
        }, 1200);
      });
    });
    actions.appendChild(copyBtn);
    pre.appendChild(actions);

    // Collapse long blocks behind a full-width toggle bar inserted right after
    // the <pre> (a sibling, not absolute-positioned, so it never drifts when the
    // block scrolls horizontally).
    const lines = text.split('\n').length;
    if (lines > COLLAPSE_LINES && pre.parentElement) {
      pre.classList.add('md-collapsed');
      const expandLabel = `Show all ${lines} lines`;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'md-expand-btn';
      toggle.textContent = expandLabel;
      toggle.addEventListener('click', () => {
        toggle.textContent = pre.classList.toggle('md-collapsed') ? expandLabel : 'Collapse';
      });
      pre.insertAdjacentElement('afterend', toggle);
    }
  });
}

/* ── mermaid diagrams ───────────────────────────────────────────────────── */

let mermaidSeq = 0;

/**
 * Replace ```mermaid fences with rendered SVG diagrams. The library (~1MB) is
 * imported lazily on the first diagram ever seen, so transcripts without
 * diagrams never pay for it. `parse` validates first: a partially-streamed or
 * invalid diagram simply stays a code block (and is retried on the next chunk,
 * since streaming rebuilds the HTML). Theme follows `data-theme` at render time.
 */
async function renderMermaidBlocks(root: HTMLElement): Promise<void> {
  const blocks = root.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
  if (blocks.length === 0) return;
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: document.documentElement.dataset.theme === 'light' ? 'default' : 'dark',
  });
  for (const code of blocks) {
    const pre = code.closest('pre');
    // The root may have been replaced (streaming) while the import resolved.
    if (!pre || !pre.isConnected) continue;
    const src = code.textContent ?? '';
    const id = `md-mermaid-${++mermaidSeq}`;
    try {
      await mermaid.parse(src);
      const { svg } = await mermaid.render(id, src);
      if (!pre.isConnected) continue;
      const fig = document.createElement('div');
      fig.className = 'md-mermaid';
      // mermaid sanitizes its own SVG output under securityLevel: 'strict'.
      fig.innerHTML = svg;
      pre.replaceWith(fig);
      // The sibling expand bar (long-block collapse) belongs to the replaced pre.
      const next = fig.nextElementSibling;
      if (next?.classList.contains('md-expand-btn')) next.remove();
    } catch {
      // Invalid/incomplete source: keep the highlighted code block as-is, but
      // sweep any error node mermaid may have left behind.
      document.getElementById(`d${id}`)?.remove();
    }
  }
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
    if (!ref.current) return;
    decoratePre(ref.current);
    void renderMermaidBlocks(ref.current);
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
