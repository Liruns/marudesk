import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

/**
 * Single configured `marked` instance shared across the editor preview and AI
 * chat. `marked-highlight` runs each fenced block through highlight.js: the
 * fenced language is used when valid (`hljs.getLanguage` guards unknown ids),
 * otherwise we auto-detect. The emitted `<code>` carries `hljs language-<id>`
 * classes; DOMPurify must therefore keep `class` so the token spans survive
 * sanitisation. GFM is on (tables, strikethrough, autolinks).
 */
const marked = new Marked(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      if (language) {
        return hljs.highlight(code, { language, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);
marked.setOptions({ async: false, breaks: false, gfm: true });

/**
 * Render markdown source to a sanitized HTML string. Always run the result
 * through `dangerouslySetInnerHTML` only — never bypass this function. The
 * sanitize profile mirrors the previous MarkdownPreview one (target/rel for
 * links) plus `class` so highlight.js token classes and `language-*` markers
 * are preserved.
 */
export function renderMarkdownToHtml(source: string): string {
  const raw = marked.parse(source) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel', 'class'],
  });
}
