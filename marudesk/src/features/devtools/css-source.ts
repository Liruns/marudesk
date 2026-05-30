/**
 * Pure helpers for live CSS editing (P4) and the live-CSS → workspace-patch
 * hook (§9-B). Kept free of CDP/store I/O so the range math and URL mapping are
 * unit-testable in isolation.
 *
 * Two jobs:
 *  1. Turn a single-property value change into the new declaration-block text
 *     for `CSS.setStyleTexts` — preferring a precise, formatting-preserving
 *     splice against the served stylesheet text ({@link computeBlockEdit}), with
 *     a deterministic rebuild fallback ({@link rebuildStyleText}) when ranges
 *     are missing.
 *  2. Map an edited rule's stylesheet back to a workspace-relative source path
 *     ({@link resolveStyleSheetSource}) — the gate that decides whether an edit
 *     can become a `patch:preview` or stays live-only.
 */

import type { CssProperty, CssSourceRange, CssStyle, StyleSheetHeader } from './types';

/** 0-based line/column (CDP convention) → absolute offset in `text`. */
export function lineColToOffset(text: string, line: number, column: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf('\n', offset);
    if (nl === -1) return text.length;
    offset = nl + 1;
  }
  return Math.min(offset + column, text.length);
}

function declarationText(prop: CssProperty, value: string): string {
  return `${prop.name}: ${value}${prop.important ? ' !important' : ''}`;
}

/**
 * Deterministic fallback: rebuild the whole declaration block from the parsed
 * properties, substituting the edited one. Loses original whitespace/comments
 * (so it's only used when we can't splice precisely), but always yields valid
 * declaration text for `CSS.setStyleTexts`.
 */
export function rebuildStyleText(
  style: CssStyle,
  propIndex: number,
  newValue: string,
): string {
  const parts: string[] = [];
  style.cssProperties.forEach((p, i) => {
    if (!p.name || p.disabled) return;
    parts.push(declarationText(p, i === propIndex ? newValue : p.value));
  });
  return parts.length ? parts.join('; ') + ';' : '';
}

/**
 * Precise edit: splice just the edited property's source text inside the block,
 * against the actual served stylesheet `fullText`. Returns both the original and
 * the new block text (the block's source range) — `oldBlock` is the exact bytes
 * to match in the source file (hook B `oldString`), `newBlock` doubles as the
 * `CSS.setStyleTexts` payload and the patch `newString`. Returns null if ranges
 * are missing or inconsistent (caller falls back to {@link rebuildStyleText}).
 */
export function computeBlockEdit(
  fullText: string,
  blockRange: CssSourceRange,
  prop: CssProperty,
  newValue: string,
): { oldBlock: string; newBlock: string } | null {
  if (!prop.range) return null;
  const blockStart = lineColToOffset(fullText, blockRange.startLine, blockRange.startColumn);
  const blockEnd = lineColToOffset(fullText, blockRange.endLine, blockRange.endColumn);
  const propStart = lineColToOffset(fullText, prop.range.startLine, prop.range.startColumn);
  const propEnd = lineColToOffset(fullText, prop.range.endLine, prop.range.endColumn);
  if (
    blockStart >= blockEnd ||
    propStart < blockStart ||
    propEnd > blockEnd ||
    propStart >= propEnd
  ) {
    return null;
  }
  const oldBlock = fullText.slice(blockStart, blockEnd);
  const rs = propStart - blockStart;
  const re = propEnd - blockStart;
  const newBlock = oldBlock.slice(0, rs) + declarationText(prop, newValue) + oldBlock.slice(re);
  return { oldBlock, newBlock };
}

/**
 * Map a stylesheet to a workspace-relative source path, or null for live-only.
 *
 * Scope (§9-B / §19): a same-origin **author** stylesheet whose URL path mirrors
 * a workspace file — i.e. the open workspace's dev server (or a static server)
 * serving real `.css` files. The `patch:preview` existence + uniqueness check
 * downstream is the final gate. Vite's JS-injected `<style>` for imported CSS
 * usually carries no `sourceURL` and falls through here to live-only; owner-node
 * (`data-vite-dev-id`) and external-sourcemap resolution are deferred.
 */
export function resolveStyleSheetSource(
  header: StyleSheetHeader,
  docOrigin: string,
): string | null {
  if (header.origin !== 'regular') return null;
  if (!header.sourceURL || !docOrigin) return null;
  let u: URL;
  try {
    u = new URL(header.sourceURL);
  } catch {
    return null;
  }
  if (u.origin !== docOrigin) return null; // only the inspected app's own files
  let p: string;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (p.startsWith('/')) p = p.slice(1);
  // Reject empty / directory-like / traversal paths; patch's fs-safe resolver is
  // the authoritative guard, but bail early on obviously non-file paths.
  if (!p || p.endsWith('/') || p.includes('..')) return null;
  return p;
}
