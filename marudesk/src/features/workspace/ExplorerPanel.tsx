import {
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  ChevronsDownUp,
  ClipboardPaste,
  Copy,
  ExternalLink,
  File as FileIcon,
  FilePlus,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Link,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
} from 'lucide-react';
import { Spinner } from '../../components/ui';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import { cn } from '../../lib/cn';
import { useWorkspaceStore } from './store';
import { useEditorStore } from '../editor/store';
import { buildFileTree, flattenTree } from './tree';
import { FileTree, type MenuTarget } from './FileTree';
import {
  commitCreate,
  commitRename,
  copyAbsolutePath,
  copyRelativePath,
  deletePath,
  pasteInto,
  revealPath,
} from './fsActions';

type Props = {
  open: boolean;
};

type MenuState = { x: number; y: number; target: MenuTarget };

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(0, i) : '';
}

// Explorer width is user-resizable (VSCode/Cursor pattern). Persisted locally so
// it survives reloads; clamped so the panel can't be dragged uselessly thin or
// eat the whole window.
const EXPLORER_MIN = 180;
const EXPLORER_MAX = 560;
const EXPLORER_DEFAULT = 260;
const EXPLORER_WIDTH_KEY = 'marudesk.explorerWidth';

function readExplorerWidth(): number {
  try {
    const v = Number(localStorage.getItem(EXPLORER_WIDTH_KEY));
    if (Number.isFinite(v) && v >= EXPLORER_MIN && v <= EXPLORER_MAX) return v;
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return EXPLORER_DEFAULT;
}

/**
 * Left-hand Explorer sidebar — the workspace file tree, VSCode/Cursor pattern.
 * Hosts open/refresh/collapse/new in the header, the tree, inline rename/new
 * inputs, and a context-sensitive right-click menu (file / folder / empty).
 *
 * The tree is built client-side from the workspace's flat file list; mutations
 * go through validated workspace:* channels (see fsActions / electron/fs-safe).
 */
export function ExplorerPanel({ open }: Props) {
  const summary = useWorkspaceStore((s) => s.summary);
  const opening = useWorkspaceStore((s) => s.opening);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const reindex = useWorkspaceStore((s) => s.reindex);
  const expandedDirs = useWorkspaceStore((s) => s.expandedDirs);
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const pendingEdit = useWorkspaceStore((s) => s.pendingEdit);
  const clipboard = useWorkspaceStore((s) => s.clipboard);
  const toggleDir = useWorkspaceStore((s) => s.toggleDir);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const collapseAll = useWorkspaceStore((s) => s.collapseAll);
  const beginRename = useWorkspaceStore((s) => s.beginRename);
  const beginCreate = useWorkspaceStore((s) => s.beginCreate);
  const cancelPending = useWorkspaceStore((s) => s.cancelPending);
  const setClipboard = useWorkspaceStore((s) => s.setClipboard);
  const openFile = useEditorStore((s) => s.openFile);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [width, setWidth] = useState(readExplorerWidth);
  const [resizing, setResizing] = useState(false);

  // Drag the right edge to resize. Pointer capture keeps move events flowing
  // even when the cursor outruns the 1px seam; the stage to the right reflows
  // automatically (its ResizeObserver re-reports web-view bounds to main).
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const asideLeft = handle.parentElement?.getBoundingClientRect().left ?? 0;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    let last = width;
    const onMove = (ev: PointerEvent) => {
      last = Math.min(EXPLORER_MAX, Math.max(EXPLORER_MIN, ev.clientX - asideLeft));
      setWidth(last);
    };
    const onDone = () => {
      setResizing(false);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('lostpointercapture', onDone);
      try {
        localStorage.setItem(EXPLORER_WIDTH_KEY, String(Math.round(last)));
      } catch {
        // best-effort persistence
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('lostpointercapture', onDone);
  };

  const tree = useMemo(
    () => (summary ? buildFileTree(summary.files) : []),
    [summary],
  );
  const rows = useMemo(
    () => flattenTree(tree, expandedDirs),
    [tree, expandedDirs],
  );

  const openRowMenu = (e: ReactMouseEvent, target: MenuTarget) => {
    e.preventDefault();
    e.stopPropagation();
    if (target.kind === 'file' || target.kind === 'dir') selectFile(target.path);
    setMenu({ x: e.clientX, y: e.clientY, target });
  };
  const openEmptyMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, target: { kind: 'empty' } });
  };

  const menuItems = (target: MenuTarget): MenuItem[] => {
    const canPaste = clipboard !== null;
    if (target.kind === 'empty') {
      return [
        { label: 'New File', icon: <FilePlus size={15} />, onSelect: () => beginCreate('', 'file') },
        { label: 'New Folder', icon: <FolderPlus size={15} />, onSelect: () => beginCreate('', 'dir') },
        { type: 'separator' },
        { label: 'Paste', icon: <ClipboardPaste size={15} />, disabled: !canPaste, onSelect: () => void pasteInto('') },
        { type: 'separator' },
        { label: 'Collapse Folders', icon: <ChevronsDownUp size={15} />, onSelect: collapseAll },
        { label: 'Refresh', icon: <RefreshCw size={15} />, onSelect: () => void reindex() },
      ];
    }
    const { kind, path } = target;
    const pasteDir = kind === 'dir' ? path : parentOf(path);
    const items: MenuItem[] = [];
    if (kind === 'file') {
      items.push({ label: 'Open', icon: <FileIcon size={15} />, onSelect: () => void openFile(path) });
    } else {
      items.push(
        { label: 'New File', icon: <FilePlus size={15} />, onSelect: () => beginCreate(path, 'file') },
        { label: 'New Folder', icon: <FolderPlus size={15} />, onSelect: () => beginCreate(path, 'dir') },
      );
    }
    items.push(
      { type: 'separator' },
      { label: 'Cut', icon: <Scissors size={15} />, onSelect: () => setClipboard(path, 'cut') },
      { label: 'Copy', icon: <Copy size={15} />, onSelect: () => setClipboard(path, 'copy') },
      { label: 'Paste', icon: <ClipboardPaste size={15} />, disabled: !canPaste, onSelect: () => void pasteInto(pasteDir) },
      { type: 'separator' },
      { label: 'Copy Path', icon: <Link size={15} />, onSelect: () => void copyAbsolutePath(path) },
      { label: 'Copy Relative Path', onSelect: () => void copyRelativePath(path) },
      { label: 'Reveal in File Explorer', icon: <ExternalLink size={15} />, onSelect: () => void revealPath(path) },
      { type: 'separator' },
      { label: 'Rename', icon: <Pencil size={15} />, onSelect: () => beginRename(path) },
      { label: 'Delete', icon: <Trash2 size={15} />, danger: true, onSelect: () => void deletePath(path) },
    );
    return items;
  };

  return (
    <aside
      role="complementary"
      aria-label="Explorer"
      aria-hidden={!open}
      className={cn(
        'relative shrink-0 bg-surface-1 border-r border-subtle overflow-hidden',
        // No width transition mid-drag — it would lag a frame behind the pointer.
        resizing ? '' : 'transition-[width] duration-standard',
      )}
      style={{ width: open ? width : 0 }}
    >
      <div className="h-full flex flex-col" style={{ width }}>
        <header className="h-9 shrink-0 flex items-center justify-between pl-3 pr-1.5 border-b border-subtle">
          <h2 className="text-caption font-medium uppercase tracking-wide text-fg-tertiary">
            Explorer
          </h2>
          <div className="flex items-center gap-0.5">
            {summary ? (
              <>
                <IconButton label="New file" onClick={() => beginCreate('', 'file')}>
                  <FilePlus size={15} />
                </IconButton>
                <IconButton label="New folder" onClick={() => beginCreate('', 'dir')}>
                  <FolderPlus size={15} />
                </IconButton>
                <IconButton label="Reindex" onClick={() => void reindex()} disabled={opening}>
                  <RefreshCw size={14} />
                </IconButton>
                <IconButton
                  label="Collapse folders"
                  onClick={collapseAll}
                  disabled={expandedDirs.size === 0}
                >
                  <ChevronsDownUp size={14} />
                </IconButton>
              </>
            ) : null}
            <IconButton
              label={summary ? 'Change folder' : 'Open folder'}
              onClick={() => void openWorkspace()}
              disabled={opening}
            >
              <FolderOpen size={15} />
            </IconButton>
          </div>
        </header>

        {summary ? (
          <>
            <div className="shrink-0 flex items-center gap-1.5 px-3 h-7 text-caption text-fg-tertiary border-b border-subtle">
              <span className="truncate text-fg-secondary" title={summary.root}>
                {summary.name}
              </span>
              <span className="tabular-nums shrink-0">
                {summary.files.length}
                {summary.truncated ? '+' : ''}
              </span>
            </div>
            <div
              className="flex-1 min-h-0 overflow-y-auto"
              onContextMenu={openEmptyMenu}
            >
              {rows.length === 0 && !pendingEdit ? (
                <p className="px-3 py-4 text-body-sm text-fg-tertiary">
                  No files in this folder.
                </p>
              ) : (
                <FileTree
                  rows={rows}
                  expanded={expandedDirs}
                  selectedPath={selectedPath}
                  pendingEdit={pendingEdit}
                  clipboard={clipboard}
                  onToggleDir={toggleDir}
                  onSelectFile={selectFile}
                  onOpenFile={(p) => void openFile(p)}
                  onContextMenu={openRowMenu}
                  onCommitRename={(p, n) => commitRename(p, n).then((r) => r !== null)}
                  onCommitCreate={(dir, n, k) =>
                    commitCreate(dir, n, k).then((r) => r !== null)
                  }
                  onCancelEdit={cancelPending}
                />
              )}
              {summary.truncated ? (
                <p className="px-3 py-2 text-caption text-fg-tertiary border-t border-subtle">
                  Showing the first {summary.files.length} files.
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="size-10 rounded-lg bg-surface-2 flex items-center justify-center text-fg-tertiary">
              <FolderSearch size={20} />
            </span>
            <p className="text-body-sm text-fg-secondary">No folder open</p>
            <p className="text-caption text-fg-tertiary">
              Open a folder to browse its files as a tree.
            </p>
            <button
              type="button"
              onClick={() => void openWorkspace()}
              disabled={opening}
              className={cn(
                'mt-1 inline-flex items-center gap-2 h-8 px-3 rounded-md text-body-sm',
                'bg-accent text-white transition-opacity duration-fast',
                opening ? 'opacity-60 cursor-not-allowed' : 'hover:opacity-90',
              )}
            >
              {opening ? <Spinner size={14} /> : <FolderOpen size={15} />}
              Open Folder
            </button>
          </div>
        )}
      </div>

      {open ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Explorer"
          onPointerDown={onResizeStart}
          className={cn(
            'absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize',
            'transition-colors duration-fast',
            resizing ? 'bg-accent' : 'bg-transparent hover:bg-accent/60',
          )}
        >
          {/* Wider invisible hit area, kept inside the panel (overflow-hidden). */}
          <span aria-hidden className="absolute inset-y-0 -left-1 right-0" />
        </div>
      ) : null}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.target)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </aside>
  );
}

function IconButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'size-6 rounded flex items-center justify-center shrink-0',
        'transition-colors duration-fast',
        disabled
          ? 'text-fg-tertiary/40 cursor-not-allowed'
          : 'text-fg-tertiary hover:text-fg-primary hover:bg-surface-2',
      )}
    >
      {children}
    </button>
  );
}
