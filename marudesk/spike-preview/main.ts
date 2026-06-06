import '../src/styles/tokens.css';
import { FileTree } from '@pierre/trees';

// Same token -> --trees-*-override mapping the spike component uses, so this
// preview reflects the real theming. Colored built-in icons are enabled.
const TREE_THEME_CSS = `:host {
  --trees-bg-override: var(--surface-1);
  --trees-fg-override: var(--text-secondary);
  --trees-fg-muted-override: var(--text-tertiary);
  --trees-selected-bg-override: var(--accent-subtle);
  --trees-selected-fg-override: var(--text-primary);
  --trees-selected-focused-border-color-override: transparent;
  --trees-accent-override: var(--accent);
  --trees-border-color-override: var(--border-subtle);
  --trees-border-radius-override: 6px;
  --trees-focus-ring-color-override: var(--accent);
  --trees-indent-guide-bg-override: var(--border-subtle);
  --trees-font-family-override: var(--font-body);
  --trees-font-size-override: 13px;
  --trees-input-bg-override: var(--surface-3);
  --trees-search-bg-override: var(--surface-3);
  --trees-search-fg-override: var(--text-primary);
  --trees-scrollbar-thumb-override: var(--surface-3);
}`;

const paths = [
  '.github/workflows/ci.yml',
  '.gitignore',
  'Dockerfile',
  'README.md',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'public/favicon.svg',
  'public/logo.png',
  'docs/spec.md',
  'src/main.tsx',
  'src/App.tsx',
  'src/index.css',
  'src/api/client.ts',
  'src/api/schema.json',
  'src/lib/cn.ts',
  'src/lib/utils.ts',
  'src/components/Button.tsx',
  'src/styles/tokens.css',
  'src/features/workspace/FileTree.tsx',
  'src/features/workspace/tree.ts',
];

// Page chrome to mimic the Explorer sidebar on the deep page canvas.
const app = document.getElementById('app')!;
document.body.style.cssText =
  'margin:0;background:var(--surface-page);color:var(--text-primary);' +
  "font-family:var(--font-body);min-height:100vh;display:flex;";

const sidebar = document.createElement('aside');
sidebar.style.cssText =
  'width:280px;height:100vh;background:var(--surface-1);' +
  'border-right:1px solid var(--border-subtle);display:flex;flex-direction:column;';

const header = document.createElement('div');
header.style.cssText =
  'height:36px;display:flex;align-items:center;padding:0 12px;' +
  'border-bottom:1px solid var(--border-subtle);font-size:11px;font-weight:500;' +
  'letter-spacing:0.04em;text-transform:uppercase;color:var(--text-tertiary);';
header.textContent = 'Explorer';

const treeMount = document.createElement('div');
treeMount.style.cssText = 'flex:1;min-height:0;display:flex;';

sidebar.append(header, treeMount);
app.append(sidebar);

const tree = new FileTree({
  paths,
  initialExpansion: 'open',
  icons: { set: 'complete', colored: true },
  unsafeCSS: TREE_THEME_CSS,
});
tree.render({ containerWrapper: treeMount });

// Signal readiness for the screenshot harness.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    document.body.setAttribute('data-tree-ready', 'true');
  });
});
