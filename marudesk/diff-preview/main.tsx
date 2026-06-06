import '../src/styles/tokens.css';
import { StrictMode, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { PatchDiff } from '@pierre/diffs/react';

// A realistic unified diff: a pure addition (import), a context line, and a
// genuine 1:1 line edit. This keeps intra-line pairing meaningful so word-alt
// boxes exactly the inserted `twMerge( … )` wrapper and leaves unchanged code
// (including `inputs`) un-boxed — rather than the misleading cross-line token
// match a full-block replacement would produce.
const SAMPLE_PATCH = `diff --git a/src/lib/cn.ts b/src/lib/cn.ts
index 1234567..89abcde 100644
--- a/src/lib/cn.ts
+++ b/src/lib/cn.ts
@@ -1,7 +1,8 @@
 import { clsx, type ClassValue } from 'clsx';
+import { twMerge } from 'tailwind-merge';

 export function cn(...inputs: ClassValue[]): string {
-  return clsx(inputs);
+  return twMerge(clsx(inputs));
 }

 export const noop = () => {};
`;

document.body.style.cssText =
  'margin:0;padding:24px;background:var(--surface-page);min-height:100vh;' +
  "font-family:var(--font-body);box-sizing:border-box;";

const mount = document.getElementById('app')!;
mount.style.cssText = 'max-width:760px;margin:0 auto;';

// Mirror the DiffViewer spike: shiki-js engine (no WASM) + token chrome.
const DIFF_CHROME_STYLE = {
  border: '1px solid var(--border-default)',
  borderRadius: '8px',
  overflow: 'hidden',
  '--diffs-bg-buffer-override': 'var(--surface-1)',
  '--diffs-bg-context-override': 'var(--surface-1)',
  '--diffs-bg-context-gutter-override': 'var(--surface-1)',
  '--diffs-bg-addition-override': 'var(--success-subtle)',
  '--diffs-bg-deletion-override': 'var(--error-subtle)',
  '--diffs-bg-addition-number-override': 'var(--success-subtle)',
  '--diffs-bg-deletion-number-override': 'var(--error-subtle)',
  '--diffs-bg-addition-emphasis-override': 'color-mix(in srgb, var(--success) 22%, transparent)',
  '--diffs-bg-deletion-emphasis-override': 'color-mix(in srgb, var(--error) 22%, transparent)',
  '--diffs-bg-separator-override': 'var(--surface-2)',
  '--diffs-bg-hover-override': 'var(--surface-2)',
  '--diffs-bg-selection-override': 'var(--accent-subtle)',
  '--diffs-fg-number-override': 'var(--text-tertiary)',
} as CSSProperties;

const params = new URLSearchParams(location.search);
const diffStyle = params.get('style') === 'split' ? 'split' : 'unified';
const ld = params.get('linediff');
// Default matches the DiffViewer spike (and the library default): word-alt
// joins single-space gaps into the change span for continuous emphasis.
const lineDiffType: 'word' | 'word-alt' | 'char' | 'none' =
  ld === 'char' || ld === 'word' || ld === 'none' ? ld : 'word-alt';

createRoot(mount).render(
  <StrictMode>
    <PatchDiff
      patch={SAMPLE_PATCH}
      options={{
        theme: 'pierre-dark',
        preferredHighlighter: 'shiki-js',
        diffStyle,
        lineDiffType,
        diffIndicators: 'bars',
        expandUnchanged: true,
        stickyHeader: true,
      }}
      style={DIFF_CHROME_STYLE}
    />
  </StrictMode>,
);

// Shiki highlights asynchronously; signal readiness after a settle for the shot.
setTimeout(() => document.body.setAttribute('data-diff-ready', 'true'), 2500);
