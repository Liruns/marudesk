import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useFileTree } from '@pierre/trees/react';
import type {
  ContextMenuItem as TreeMenuItem,
  ContextMenuOpenContext as TreeMenuOpenCtx,
  FileTree as FileTreeModel,
  FileTreeRenameEvent,
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
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import { useI18n } from '../../i18n/useI18n';
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
 * Theme bridge between marudesk's design tokens and `@pierre/trees`. The tree
 * renders in a shadow root, but CSS custom properties inherit across the shadow
 * boundary, so setting the library's `--trees-*-override` hooks on the host maps
 * the whole component onto our token layer (DESIGN.md §2). Icons stay monochrome
 * (`colored: false` in the icon config) to honour the single-accent rule. The
 * indent guide derives from `--trees-fg-muted` by default, so it follows the
 * tertiary text token automatically.
 */
export const TREE_THEME_STYLE = {
  height: '100%',
  display: 'block',
  '--trees-bg-override': 'transparent',
  '--trees-fg-override': 'var(--text-secondary)',
  '--trees-fg-muted-override': 'var(--text-tertiary)',
  '--trees-accent-override': 'var(--accent)',
  '--trees-border-color-override': 'var(--border-subtle)',
  '--trees-border-radius-override': 'var(--radius-sm)',
  '--trees-focus-ring-color-override': 'var(--accent)',
  '--trees-bg-muted-override': 'var(--surface-2)',
  '--trees-selected-bg-override': 'var(--accent-subtle)',
  '--trees-selected-fg-override': 'var(--text-primary)',
  '--trees-selected-focused-border-color-override': 'var(--accent)',
  '--trees-indent-guide-bg-override': 'var(--border-subtle)',
  '--trees-input-bg-override': 'var(--surface-3)',
  '--trees-scrollbar-thumb-override': 'var(--scrollbar-thumb)',
  '--trees-font-family-override': 'var(--font-body)',
  '--trees-font-size-override': '13px',
} as CSSProperties;

/** A new-item placeholder awaiting its name in the inline rename input. */
type PendingCreate = {
  tempPath: string;
  parentDir: string;
  kind: 'file' | 'dir';
};

type PathKind = 'dir' | 'file';

/** Parent directory of a POSIX-relative path ('' for a top-level entry). */
function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(0, i) : '';
}

function baseName(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(i + 1) : rel;
}

/**
 * Derive the per-path kind map and the set of directory paths from a flat file
 * list. The backend returns files only; intermediate directories are inferred
 * from path segments (mirrors the previous `buildFileTree` behaviour).
 */
function computeKinds(paths: readonly string[]): {
  kinds: Map<string, PathKind>;
  dirs: string[];
} {
  const kinds = new Map<string, PathKind>();
  const dirs = new Set<string>();
  for (const p of paths) {
    kinds.set(p, 'file');
    const segs = p.split('/');
    let prefix = '';
    for (let i = 0; i < segs.length - 1; i++) {
      prefix = prefix ? `${prefix}/${segs[i]}` : segs[i];
      dirs.add(prefix);
    }
  }
  for (const d of dirs) kinds.set(d, 'dir');
  return { kinds, dirs: [...dirs] };
}

type Result = {
  model: FileTreeModel;
  renderContextMenu: (item: TreeMenuItem, ctx: TreeMenuOpenCtx) => ReactNode;
  beginCreate: (parentDir: string, kind: 'file' | 'dir') => void;
  collapseAll: () => void;
};

/**
 * Wires `@pierre/trees` to marudesk's workspace: feeds it the file list, opens
 * files on selection, drives inline rename / create through the validated
 * `workspace:*` channels (fsActions), and renders our own ContextMenu via the
 * library's `renderContextMenu` slot.
 *
 * The model is created once (the library never re-reads options), so paths are
 * pushed imperatively via `resetPaths` whenever the summary changes — expansion
 * and selection are snapshotted and restored across the reset so a reindex
 * (which fires after every fs mutation) doesn't collapse the tree.
 */
export function useWorkspaceTree(opts: {
  onOpenFile: (path: string) => void;
}): Result {
  const { t } = useI18n();
  const summary = useWorkspaceStore((s) => s.summary);

  // Refs so the once-captured library callbacks (onSelectionChange / onRename,
  // which the library reads only at construction) always see live values.
  const modelRef = useRef<FileTreeModel | null>(null);
  const onOpenFileRef = useRef(opts.onOpenFile);
  const pathKindRef = useRef<Map<string, PathKind>>(new Map());
  const currentPathsRef = useRef<readonly string[]>([]);
  const pendingCreateRef = useRef<PendingCreate | null>(null);
  // Suppresses the open-on-select side effect while we restore selection
  // programmatically after a resetPaths.
  const suppressSelRef = useRef(false);

  const handleSelection = useCallback((selectedPaths: readonly string[]) => {
    if (suppressSelRef.current) return;
    const path = selectedPaths[selectedPaths.length - 1];
    if (!path) return;
    useWorkspaceStore.getState().selectFile(path);
    if (pathKindRef.current.get(path) === 'file') {
      onOpenFileRef.current(path);
    }
  }, []);

  const handleRename = useCallback((event: FileTreeRenameEvent) => {
    const newName = baseName(event.destinationPath);
    const pending = pendingCreateRef.current;
    if (pending && pending.tempPath === event.sourcePath) {
      // Committing a new-item placeholder: create on disk instead of moving.
      pendingCreateRef.current = null;
      void commitCreate(pending.parentDir, newName, pending.kind).then((res) => {
        // On failure drop the optimistic placeholder the library left behind.
        if (!res) modelRef.current?.remove(event.destinationPath);
      });
      return;
    }
    void commitRename(event.sourcePath, newName).then((res) => {
      // On failure re-sync the model from disk (the library already moved the
      // node optimistically; reindex restores the truth).
      if (!res) void useWorkspaceStore.getState().reindex();
    });
  }, []);

  const { model } = useFileTree({
    paths: [],
    initialExpansion: 'closed',
    icons: { set: 'standard', colored: false },
    renaming: {
      onRename: handleRename,
      onError: (error) => window.alert(error),
    },
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: 'both',
        buttonVisibility: 'when-needed',
      },
    },
    onSelectionChange: handleSelection,
  });

  // `model` is stable (the library creates it once), so mirror it — and the
  // latest open-file callback — into refs for the once-captured handlers above.
  useEffect(() => {
    modelRef.current = model;
    onOpenFileRef.current = opts.onOpenFile;
  });

  // Push the file list into the model whenever the summary changes, preserving
  // expansion + selection across the reset.
  useEffect(() => {
    const paths = (summary?.files ?? []).map((f) => f.path);
    const { kinds, dirs } = computeKinds(paths);
    pathKindRef.current = kinds;
    currentPathsRef.current = paths;
    const expanded = dirs.filter((d) => {
      const item = model.getItem(d);
      // `isExpanded` lives only on the directory handle of the item union.
      return !!item && 'isExpanded' in item && item.isExpanded();
    });
    suppressSelRef.current = true;
    try {
      model.resetPaths(paths, { initialExpandedPaths: expanded });
      const sel = useWorkspaceStore.getState().selectedPath;
      if (sel && kinds.has(sel)) model.getItem(sel)?.select();
    } finally {
      suppressSelRef.current = false;
    }
  }, [summary, model]);

  const beginCreate = useCallback(
    (parentDir: string, kind: 'file' | 'dir') => {
      const base = kind === 'dir' ? 'new-folder' : 'new-file';
      const exists = (nm: string) =>
        pathKindRef.current.has(parentDir ? `${parentDir}/${nm}` : nm);
      let name = base;
      for (let n = 1; exists(name); n++) name = `${base}-${n}`;
      const tempPath = parentDir ? `${parentDir}/${name}` : name;
      if (parentDir) {
        const dir = model.getItem(parentDir);
        if (dir && 'expand' in dir) dir.expand();
      }
      pendingCreateRef.current = { tempPath, parentDir, kind };
      model.add(tempPath);
      model.startRenaming(tempPath, { removeIfCanceled: true });
    },
    [model],
  );

  const collapseAll = useCallback(() => {
    suppressSelRef.current = true;
    try {
      model.resetPaths(currentPathsRef.current, { initialExpandedPaths: [] });
      const sel = useWorkspaceStore.getState().selectedPath;
      if (sel && pathKindRef.current.has(sel)) model.getItem(sel)?.select();
    } finally {
      suppressSelRef.current = false;
    }
  }, [model]);

  const buildRowMenu = useCallback(
    (item: TreeMenuItem): MenuItem[] => {
      const path = item.path;
      const isDir = item.kind === 'directory';
      const canPaste = useWorkspaceStore.getState().clipboard !== null;
      const pasteDir = isDir ? path : parentOf(path);
      const items: MenuItem[] = [];
      if (!isDir) {
        items.push({
          label: t('workspace.action.open'),
          icon: <FileIcon size={15} />,
          onSelect: () => onOpenFileRef.current(path),
        });
      } else {
        items.push(
          {
            label: t('workspace.action.newFile'),
            icon: <FilePlus size={15} />,
            onSelect: () => beginCreate(path, 'file'),
          },
          {
            label: t('workspace.action.newFolder'),
            icon: <FolderPlus size={15} />,
            onSelect: () => beginCreate(path, 'dir'),
          },
        );
      }
      items.push(
        { type: 'separator' },
        {
          label: t('workspace.action.cut'),
          icon: <Scissors size={15} />,
          onSelect: () => useWorkspaceStore.getState().setClipboard(path, 'cut'),
        },
        {
          label: t('workspace.action.copy'),
          icon: <Copy size={15} />,
          onSelect: () => useWorkspaceStore.getState().setClipboard(path, 'copy'),
        },
        {
          label: t('workspace.action.paste'),
          icon: <ClipboardPaste size={15} />,
          disabled: !canPaste,
          onSelect: () => void pasteInto(pasteDir),
        },
        { type: 'separator' },
        {
          label: t('workspace.action.copyPath'),
          icon: <Link size={15} />,
          onSelect: () => void copyAbsolutePath(path),
        },
        {
          label: t('workspace.action.copyRelativePath'),
          onSelect: () => void copyRelativePath(path),
        },
        {
          label: t('workspace.action.revealInFileExplorer'),
          icon: <ExternalLink size={15} />,
          onSelect: () => void revealPath(path),
        },
        { type: 'separator' },
        {
          label: t('workspace.action.rename'),
          icon: <Pencil size={15} />,
          onSelect: () => model.startRenaming(path),
        },
        {
          label: t('workspace.action.delete'),
          icon: <Trash2 size={15} />,
          danger: true,
          onSelect: () => void deletePath(path),
        },
      );
      return items;
    },
    [t, beginCreate, model],
  );

  const renderContextMenu = useCallback(
    (item: TreeMenuItem, ctx: TreeMenuOpenCtx): ReactNode => (
      <ContextMenu
        x={ctx.anchorRect.left}
        y={ctx.anchorRect.bottom}
        contextMenuRoot
        items={buildRowMenu(item)}
        // Close without restoring row focus so actions that hand focus to the
        // inline rename input (rename / new item) aren't yanked back.
        onClose={() => ctx.close({ restoreFocus: false })}
      />
    ),
    [buildRowMenu],
  );

  return { model, renderContextMenu, beginCreate, collapseAll };
}
