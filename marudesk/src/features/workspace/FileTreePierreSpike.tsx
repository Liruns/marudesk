import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { prepareFileTreeInput } from '@pierre/trees';
import type {
  ContextMenuItem as FileTreeContextMenuItem,
  ContextMenuOpenContext as FileTreeContextMenuOpenContext,
  FileTreeRenameEvent,
  FileTreeRenamingItem,
} from '@pierre/trees';
import {
  ClipboardPaste,
  Copy,
  ExternalLink,
  File as FileIcon,
  FilePlus,
  FolderPlus,
  Link,
  Pencil,
  Scissors,
  Trash2,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import type { FileEntry } from '../../../shared/workspace';
import { useWorkspaceStore } from './store';
import {
  commitCreate,
  commitRename,
  copyAbsolutePath,
  copyRelativePath,
  deletePath,
  pasteInto,
  revealPath,
} from './fsActions';

/**
 * SPIKE — file tree rendered via @pierre/trees instead of the in-house
 * `FileTree`. Wired behind the `USE_PIERRE_TREE` flag in ExplorerPanel (default
 * off) so it can be exercised in the real surface without changing shipped
 * behavior. The goal is to learn what bridges cleanly and what needs custom
 * work; see `docs/pierre-trees-spike.md` for the findings.
 *
 * What is wired:
 * - paths/data from the workspace flat file list, kept in sync via resetPaths
 * - selection -> open file (the library exposes no separate "activate" event;
 *   for marudesk's single-click-opens this maps 1:1)
 * - inline rename (library built-in) -> workspace:rename
 * - inline create (add + startRenaming with removeIfCanceled) -> workspace:create
 * - right-click menu drawn with marudesk tokens (the slotted node lives in light
 *   DOM, so Tailwind classes apply) wired to fsActions + the store clipboard
 * - theming mapped from design tokens onto the library --trees-*-override vars,
 *   set on the host `style` prop (the docs' first-class styling surface — not
 *   the `unsafeCSS` escape hatch, which is reserved for cases the variable
 *   surface can't express)
 *
 * Icons use Pierre's built-in colored file-type set (`set: 'complete',
 * colored: true`) — the per-type chromatic glyphs are a deliberate design
 * upgrade over the in-house monochrome Lucide glyphs, and override the
 * DESIGN.md §11 "Lucide-only / currentColor" rule for this surface.
 *
 * Known gaps (documented, not yet bridged): cut-dimming visual, git-status
 * decorations, and expansion preservation across resetPaths.
 */

// Map design tokens onto the library's override variables. Per the docs these
// are the first-class styling surface (fallback layer 1: `--trees-*-override`
// → `--trees-theme-*` → defaults) and belong on the host element's `style`.
// Custom properties inherit through the shadow boundary, so `var(--surface-1)`
// etc. resolve against marudesk's :root tokens.
const TREE_THEME_STYLE = {
  '--trees-bg-override': 'var(--surface-1)',
  '--trees-fg-override': 'var(--text-secondary)',
  '--trees-fg-muted-override': 'var(--text-tertiary)',
  '--trees-selected-bg-override': 'var(--accent-subtle)',
  '--trees-selected-fg-override': 'var(--text-primary)',
  '--trees-selected-focused-border-color-override': 'transparent',
  '--trees-accent-override': 'var(--accent)',
  '--trees-border-color-override': 'var(--border-subtle)',
  '--trees-border-radius-override': '6px',
  '--trees-focus-ring-color-override': 'var(--accent)',
  '--trees-indent-guide-bg-override': 'var(--border-subtle)',
  '--trees-font-family-override': 'var(--font-body)',
  '--trees-font-size-override': '13px',
  '--trees-input-bg-override': 'var(--surface-3)',
  '--trees-search-bg-override': 'var(--surface-3)',
  '--trees-search-fg-override': 'var(--text-primary)',
  '--trees-scrollbar-thumb-override': 'var(--surface-3)',
  '--trees-git-added-color-override': 'var(--success)',
  '--trees-git-modified-color-override': 'var(--warning)',
  '--trees-git-deleted-color-override': 'var(--error)',
  '--trees-git-untracked-color-override': 'var(--success)',
} as CSSProperties;

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

// Root manifests / lockfiles whose rename would break tooling. The docs
// recommend a `canRename` guard for exactly this; the in-house tree had none,
// so this is a small, deliberate hardening.
const RENAME_PROTECTED = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.git',
]);

type MenuRow = {
  label: string;
  icon: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

type Props = {
  files: FileEntry[];
  onOpenFile: (path: string) => void;
};

export function FileTreePierreSpike({ files, onOpenFile }: Props) {
  const clipboard = useWorkspaceStore((s) => s.clipboard);
  const setClipboard = useWorkspaceStore((s) => s.setClipboard);

  // All workspace entries are files; directories are derived from path
  // segments, so any path present here is always openable.
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const fileSet = useMemo(() => new Set(paths), [paths]);

  // The docs treat raw `paths` as the demo/small-tree path and recommend
  // prepared input (ideally produced off the UI boundary) for real trees. We
  // shape it here in the renderer for now; the production move is to emit
  // presorted prepared input from the main process that already builds the
  // file list. `flattenEmptyDirectories: false` keeps one row per directory,
  // matching the in-house tree (flip to true for VSCode-style compact folders).
  const preparedInput = useMemo(
    () => prepareFileTreeInput(paths, { flattenEmptyDirectories: false }),
    [paths],
  );

  // Latest values for listeners captured once at construction, so selection ->
  // open never goes stale across re-renders. Refreshed after commit (not during
  // render); the listeners that read it only fire on later user interaction.
  const latest = useRef({ fileSet, onOpenFile });
  useEffect(() => {
    latest.current = { fileSet, onOpenFile };
  });

  // Placeholder paths mid-creation -> kind, so the single rename handler can
  // route "finish create" vs "finish rename".
  const pendingCreates = useRef(new Map<string, 'file' | 'dir'>());

  // onRename fires after the model has optimistically moved the node; persist
  // to disk and let reindex -> resetPaths reconcile against the real tree. Kept
  // in a ref (refreshed after commit) so the handler closes over current props
  // without re-subscribing the tree on every render.
  const onRenameRef = useRef<(e: FileTreeRenameEvent) => void>(() => {});
  useEffect(() => {
    onRenameRef.current = (e) => {
      const kind = pendingCreates.current.get(e.sourcePath);
      if (kind) {
        pendingCreates.current.delete(e.sourcePath);
        void commitCreate(parentOf(e.destinationPath), basename(e.destinationPath), kind);
      } else {
        void commitRename(e.sourcePath, basename(e.destinationPath));
      }
    };
  });

  const { model } = useFileTree({
    preparedInput,
    initialExpansion: 'closed',
    search: true,
    density: 'default',
    // One row per directory (parity with the in-house tree). The store-level
    // option is the effective knob — the prepareFileTreeInput option alone does
    // not disable the projection-time flattening. Flip both to true for compact
    // VSCode-style single-child folder chains.
    flattenEmptyDirectories: false,
    renaming: {
      canRename: (item: FileTreeRenamingItem) => !RENAME_PROTECTED.has(basename(item.path)),
      onRename: (e) => onRenameRef.current(e),
      onError: (message) => window.alert(message),
    },
    icons: { set: 'complete', colored: true },
    onSelectionChange: (selected) => {
      const { fileSet: fs, onOpenFile: open } = latest.current;
      for (const p of selected) if (fs.has(p)) open(p);
    },
  });

  // Reconcile to disk truth whenever the file list changes. The first value is
  // already in the constructor options, so skip the initial run.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    model.resetPaths(paths, { preparedInput });
  }, [preparedInput, paths, model]);

  const beginCreate = (parentDir: string, kind: 'file' | 'dir') => {
    const base = kind === 'dir' ? 'new-folder' : 'new-file';
    let name = base;
    let n = 1;
    let placeholder = parentDir ? `${parentDir}/${name}` : name;
    while (model.getItem(placeholder) != null) {
      name = `${base}-${n++}`;
      placeholder = parentDir ? `${parentDir}/${name}` : name;
    }
    pendingCreates.current.set(placeholder, kind);
    model.add(placeholder);
    model.startRenaming(placeholder, { removeIfCanceled: true });
  };

  const renderContextMenu = (
    item: FileTreeContextMenuItem,
    context: FileTreeContextMenuOpenContext,
  ): ReactNode => {
    const isDir = item.kind === 'directory';
    const pasteDir = isDir ? item.path : parentOf(item.path);
    const run = (fn: () => void) => () => {
      context.close({ restoreFocus: false });
      fn();
    };
    const rows: MenuRow[] = [];
    if (isDir) {
      rows.push(
        { label: 'New File', icon: <FilePlus size={15} />, onSelect: () => beginCreate(item.path, 'file') },
        { label: 'New Folder', icon: <FolderPlus size={15} />, onSelect: () => beginCreate(item.path, 'dir') },
      );
    } else {
      rows.push({ label: 'Open', icon: <FileIcon size={15} />, onSelect: () => onOpenFile(item.path) });
    }
    rows.push(
      { label: 'Rename', icon: <Pencil size={15} />, onSelect: () => model.startRenaming(item.path) },
      { label: 'Cut', icon: <Scissors size={15} />, onSelect: () => setClipboard(item.path, 'cut') },
      { label: 'Copy', icon: <Copy size={15} />, onSelect: () => setClipboard(item.path, 'copy') },
      {
        label: 'Paste',
        icon: <ClipboardPaste size={15} />,
        disabled: clipboard === null,
        onSelect: () => void pasteInto(pasteDir),
      },
      { label: 'Copy Path', icon: <Link size={15} />, onSelect: () => void copyAbsolutePath(item.path) },
      { label: 'Copy Relative Path', icon: <Copy size={15} />, onSelect: () => void copyRelativePath(item.path) },
      { label: 'Reveal in File Explorer', icon: <ExternalLink size={15} />, onSelect: () => void revealPath(item.path) },
      { label: 'Delete', icon: <Trash2 size={15} />, danger: true, onSelect: () => void deletePath(item.path) },
    );

    return (
      <div
        data-file-tree-context-menu-root="true"
        className="chrome-popover min-w-[200px] py-1 rounded text-body-sm text-fg-primary"
      >
        {rows.map((r) => (
          <button
            key={r.label}
            type="button"
            disabled={r.disabled}
            onClick={r.disabled ? undefined : run(r.onSelect)}
            className={cn(
              'chrome-list-row w-full gap-2.5 px-3 h-7 text-left outline-none rounded-none',
              r.disabled
                ? 'text-fg-tertiary/50 cursor-not-allowed'
                : r.danger
                  ? 'text-error hover:bg-error-subtle'
                  : 'text-fg-secondary hover:bg-surface-3 hover:text-fg-primary',
            )}
          >
            <span className="size-4 shrink-0 flex items-center justify-center text-fg-tertiary">
              {r.icon}
            </span>
            <span className="flex-1 min-w-0 truncate">{r.label}</span>
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="h-full min-h-0">
      <FileTree
        model={model}
        renderContextMenu={renderContextMenu}
        style={{ height: '100%', ...TREE_THEME_STYLE }}
      />
    </div>
  );
}
