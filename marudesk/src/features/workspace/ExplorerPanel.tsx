import {
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ChevronsDownUp,
  ClipboardPaste,
  Columns2,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  File as FileIcon,
  FilePlus,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Link,
  Pencil,
  RefreshCw,
  Rows2,
  Scissors,
  Trash2,
} from 'lucide-react';
import { Spinner } from '../../components/ui';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { readStoredWidth, writeStoredWidth } from '../../lib/panelWidth';
import type {
  FileEntry,
  WorkspaceFileRef,
} from '../../../shared/workspace';
import { IconButton, WorkspaceRootsBar } from './ExplorerPanel.parts';
import { useWorkspaceStore } from './store';
import { serializeFileDrag } from './fileDrag';
import { useEditorStore } from '../editor/store';
import { useWorkspaceDeckStore } from '../workspaces/store';
import { buildFileTree, flattenTree } from './tree';
import { FileTree, type MenuTarget } from './FileTree';
import { FileTreePierreSpike } from './FileTreePierreSpike';
import { useGridStore } from '../tabs/grid';
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
  onRequestClose?: () => void;
};

type MenuState = { x: number; y: number; target: MenuTarget };

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(0, i) : '';
}

// Explorer width is user-resizable (VSCode/Cursor pattern). Persisted locally so
// it survives reloads; clamped so the panel can't be dragged uselessly thin or
// eat the whole window.
// Min usable width is deliberately narrow (a file tree stays readable well below
// the old 180px floor) so the panel can be tucked in tight without dismissing.
const EXPLORER_MIN = 120;
const EXPLORER_MAX = 560;
const EXPLORER_DEFAULT = 260;
const EXPLORER_WIDTH_KEY = 'marudesk.explorerWidth';
// Below this threshold on drag-release the panel closes entirely ("drag to
// dismiss"). Kept well under EXPLORER_MIN so closing is intentional — you only
// dismiss by dragging it nearly shut, not by merely making it narrow. During the
// drag we allow live narrowing to EXPLORER_DRAG_FLOOR so the panel visibly
// shrinks toward the close zone before the user lets go.
const EXPLORER_CLOSE_AT = 72;
const EXPLORER_DRAG_FLOOR = 44;

// "Show ignored files" preference — when on, the tree also lists git-ignored
// (and dotfile) entries, fetched on demand without disturbing the curated
// workspace summary used by search/mentions.
const SHOW_IGNORED_KEY = 'marudesk.explorer.showIgnored';
function readShowIgnored(): boolean {
  try {
    return localStorage.getItem(SHOW_IGNORED_KEY) === '1';
  } catch {
    return false;
  }
}

// SPIKE flag: render the @pierre/trees-backed tree instead of the in-house one.
// Default off so shipped behavior is unchanged; flip locally to evaluate.
// See FileTreePierreSpike.tsx / docs/pierre-trees-spike.md.
const USE_PIERRE_TREE = true;

function readExplorerWidth(): number {
  return readStoredWidth(EXPLORER_WIDTH_KEY, EXPLORER_MIN, EXPLORER_MAX, EXPLORER_DEFAULT);
}

/**
 * Left-hand Explorer sidebar — the workspace file tree, VSCode/Cursor pattern.
 * Hosts open/refresh/collapse/new in the header, the tree, inline rename/new
 * inputs, and a context-sensitive right-click menu (file / folder / empty).
 *
 * The tree is built client-side from the workspace's flat file list; mutations
 * go through validated workspace:* channels (see fsActions / electron/fs-safe).
 */
export function ExplorerPanel({ open, onRequestClose }: Props) {
  const { formatFileCount, formatWorkspaceTruncated, t } = useI18n();
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
  const workspaces = useWorkspaceDeckStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceDeckStore((s) => s.activeWorkspaceId);
  const setActiveRoot = useWorkspaceDeckStore((s) => s.setActiveRoot);
  const addRoot = useWorkspaceDeckStore((s) => s.addRoot);
  const removeRoot = useWorkspaceDeckStore((s) => s.removeRoot);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [width, setWidth] = useState(readExplorerWidth);
  const [resizing, setResizing] = useState(false);
  // "Show ignored files" toggle + the ignored-inclusive listing it fetches.
  // The listing is tagged with the root it was fetched for, so a stale list from
  // another workspace is simply not displayed — no state reset needed.
  const [showIgnored, setShowIgnored] = useState(readShowIgnored);
  const [ignoredFiles, setIgnoredFiles] = useState<{
    root: string;
    files: FileEntry[];
  } | null>(null);
  // Tracks whether we are in the "close zone" during an active drag — used to
  // show the dismiss affordance without touching the persisted width state.
  const [inCloseZone, setInCloseZone] = useState(false);

  // Drag the right edge to resize. Pointer capture keeps move events flowing
  // even when the cursor outruns the 1px seam; the stage to the right reflows
  // automatically (its ResizeObserver re-reports web-view bounds to main).
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const asideLeft = handle.parentElement?.getBoundingClientRect().left ?? 0;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    // `last` tracks the last raw drag value; `lastGood` is the last width that
    // was within [MIN, MAX] and is the value we persist if the user closes.
    let last = width;
    let lastGood = width >= EXPLORER_MIN ? width : EXPLORER_DEFAULT;
    const onMove = (ev: PointerEvent) => {
      // During a drag, allow shrinking below EXPLORER_MIN down to the drag
      // floor so the user sees the panel visibly narrow toward the close zone.
      last = Math.min(EXPLORER_MAX, Math.max(EXPLORER_DRAG_FLOOR, ev.clientX - asideLeft));
      if (last >= EXPLORER_MIN) lastGood = last;
      setWidth(last);
      setInCloseZone(last < EXPLORER_CLOSE_AT);
    };
    const onDone = () => {
      setResizing(false);
      setInCloseZone(false);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('lostpointercapture', onDone);
      if (last < EXPLORER_CLOSE_AT) {
        // Close zone — dismiss the panel. Restore a sane width so it isn't
        // 60px wide when the user reopens it via Ctrl+B or the ActivityBar.
        const restore = lastGood >= EXPLORER_MIN ? lastGood : EXPLORER_DEFAULT;
        setWidth(restore);
        writeStoredWidth(EXPLORER_WIDTH_KEY, restore);
        onRequestClose?.();
      } else {
        // Normal release — clamp to valid range and persist.
        const clamped = Math.min(EXPLORER_MAX, Math.max(EXPLORER_MIN, last));
        setWidth(clamped);
        writeStoredWidth(EXPLORER_WIDTH_KEY, clamped);
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('lostpointercapture', onDone);
  };

  // Fetch the ignored-inclusive listing when the toggle is on (re-fetching when
  // the active root changes). When off, the render below falls back to the
  // curated summary, so nothing needs clearing here.
  useEffect(() => {
    const root = summary?.root;
    if (!showIgnored || !root) return;
    let alive = true;
    void window.marudesk
      .invoke('workspace:list-files', { root, includeIgnored: true })
      .then((files) => {
        if (alive) setIgnoredFiles({ root, files });
      })
      .catch(() => {
        if (alive) setIgnoredFiles(null);
      });
    return () => {
      alive = false;
    };
  }, [showIgnored, summary?.root]);

  const toggleShowIgnored = () => {
    setShowIgnored((v) => {
      const next = !v;
      try {
        localStorage.setItem(SHOW_IGNORED_KEY, next ? '1' : '0');
      } catch {
        // best-effort
      }
      return next;
    });
  };

  // The list the tree renders: ignored-inclusive when the toggle is on and the
  // fetch for THIS root has resolved, otherwise the curated workspace summary.
  const displayFiles = useMemo(
    () =>
      showIgnored && ignoredFiles && ignoredFiles.root === summary?.root
        ? ignoredFiles.files
        : summary?.files ?? [],
    [showIgnored, ignoredFiles, summary],
  );
  const tree = useMemo(() => buildFileTree(displayFiles), [displayFiles]);
  const rows = useMemo(
    () => flattenTree(tree, expandedDirs),
    [tree, expandedDirs],
  );
  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces],
  );
  const activeRootId = activeWorkspace?.activeRootId ?? activeWorkspace?.roots[0]?.id ?? null;
  const workspaceFile = (filePath: string): WorkspaceFileRef | string => {
    if (!activeWorkspace || !activeRootId) return filePath;
    return {
      workspaceId: activeWorkspace.id,
      rootId: activeRootId,
      path: filePath,
    };
  };

  const handleSplitFile = async (filePath: string, dir: 'row' | 'col') => {
    const file = workspaceFile(filePath);
    const payload = typeof file === 'string'
      ? { kind: 'editor' as const, path: file }
      : { kind: 'editor' as const, file, workspaceId: file.workspaceId };
    const tabId: string = await window.marudesk.invoke('browser:tabs-new', payload);
    useGridStore.getState().splitWith(null, tabId, dir, 'after');
  };

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
        { label: t('workspace.action.newFile'), icon: <FilePlus size={15} />, onSelect: () => beginCreate('', 'file') },
        { label: t('workspace.action.newFolder'), icon: <FolderPlus size={15} />, onSelect: () => beginCreate('', 'dir') },
        { type: 'separator' },
        { label: t('workspace.action.paste'), icon: <ClipboardPaste size={15} />, disabled: !canPaste, onSelect: () => void pasteInto('') },
        { type: 'separator' },
        { label: t('workspace.action.collapseFolders'), icon: <ChevronsDownUp size={15} />, onSelect: collapseAll },
        { label: t('workspace.action.refresh'), icon: <RefreshCw size={15} />, onSelect: () => void reindex() },
      ];
    }
    const { kind, path } = target;
    const pasteDir = kind === 'dir' ? path : parentOf(path);
    const items: MenuItem[] = [];
    if (kind === 'file') {
      items.push(
        { label: t('workspace.action.open'), icon: <FileIcon size={15} />, onSelect: () => void openFile(workspaceFile(path)) },
        { label: t('workspace.action.splitRight'), icon: <Columns2 size={15} />, onSelect: () => void handleSplitFile(path, 'row') },
        { label: t('workspace.action.splitBottom'), icon: <Rows2 size={15} />, onSelect: () => void handleSplitFile(path, 'col') },
      );
    } else {
      items.push(
        { label: t('workspace.action.newFile'), icon: <FilePlus size={15} />, onSelect: () => beginCreate(path, 'file') },
        { label: t('workspace.action.newFolder'), icon: <FolderPlus size={15} />, onSelect: () => beginCreate(path, 'dir') },
      );
    }
    items.push(
      { type: 'separator' },
      { label: t('workspace.action.cut'), icon: <Scissors size={15} />, onSelect: () => setClipboard(path, 'cut') },
      { label: t('workspace.action.copy'), icon: <Copy size={15} />, onSelect: () => setClipboard(path, 'copy') },
      { label: t('workspace.action.paste'), icon: <ClipboardPaste size={15} />, disabled: !canPaste, onSelect: () => void pasteInto(pasteDir) },
      { type: 'separator' },
      { label: t('workspace.action.copyPath'), icon: <Link size={15} />, onSelect: () => void copyAbsolutePath(path) },
      { label: t('workspace.action.copyRelativePath'), onSelect: () => void copyRelativePath(path) },
      { label: t('workspace.action.revealInFileExplorer'), icon: <ExternalLink size={15} />, onSelect: () => void revealPath(path) },
      { type: 'separator' },
      { label: t('workspace.action.rename'), icon: <Pencil size={15} />, onSelect: () => beginRename(path) },
      { label: t('workspace.action.delete'), icon: <Trash2 size={15} />, danger: true, onSelect: () => void deletePath(path) },
    );
    return items;
  };

  // Close-zone affordance: dim content and tint the seam when the live drag
  // width drops into the dismiss range, signalling that releasing will close.
  const closeZoneActive = resizing && inCloseZone;

  return (
    <aside
      role="complementary"
      aria-label={t('workspace.panelLabel')}
      aria-hidden={!open}
      className={cn(
        'relative shrink-0 bg-surface-1 border-r border-subtle overflow-hidden',
        // No width transition mid-drag — it would lag a frame behind the pointer.
        resizing ? '' : 'transition-[width] duration-standard',
      )}
      style={{ width: open ? width : 0 }}
    >
      <div
        className={cn(
          'h-full flex flex-col',
          // Dim panel content when entering the close zone so the user knows
          // releasing will dismiss — transition keeps it smooth.
          closeZoneActive ? 'opacity-30 transition-opacity duration-fast' : 'transition-opacity duration-fast',
        )}
        style={{ width }}
      >
        <header className="h-9 shrink-0 flex items-center justify-between pl-3 pr-1.5 border-b border-subtle">
          <h2 className="text-caption font-medium uppercase tracking-wide text-fg-tertiary">
            {t('workspace.title')}
          </h2>
          <div className="flex items-center gap-0.5">
            {summary ? (
              <>
                <IconButton label={t('workspace.action.newFile')} onClick={() => beginCreate('', 'file')}>
                  <FilePlus size={15} />
                </IconButton>
                <IconButton label={t('workspace.action.newFolder')} onClick={() => beginCreate('', 'dir')}>
                  <FolderPlus size={15} />
                </IconButton>
                <IconButton label={t('workspace.action.reindex')} onClick={() => void reindex()} disabled={opening}>
                  <RefreshCw size={14} />
                </IconButton>
                <IconButton
                  label={t(showIgnored ? 'workspace.action.hideIgnored' : 'workspace.action.showIgnored')}
                  onClick={toggleShowIgnored}
                  active={showIgnored}
                >
                  {showIgnored ? <Eye size={14} /> : <EyeOff size={14} />}
                </IconButton>
                <IconButton
                  label={t('workspace.action.collapseFolders')}
                  onClick={collapseAll}
                  disabled={expandedDirs.size === 0}
                >
                  <ChevronsDownUp size={14} />
                </IconButton>
              </>
            ) : null}
            <IconButton
              label={summary ? t('workspace.action.changeFolder') : t('workspace.action.openFolder')}
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
                {formatFileCount({
                  count: summary.files.length,
                  truncated: summary.truncated,
                })}
              </span>
            </div>
            {activeWorkspace ? (
              <WorkspaceRootsBar
                record={activeWorkspace}
                activeRootId={activeRootId}
                onSelectRoot={(rootId) => void setActiveRoot(activeWorkspace.id, rootId)}
                onAddRoot={() => void addRoot(activeWorkspace.id)}
                onRemoveRoot={(rootId) => void removeRoot(activeWorkspace.id, rootId)}
              />
            ) : null}
            <div
              className="flex-1 min-h-0 overflow-y-auto"
              onContextMenu={openEmptyMenu}
            >
              {USE_PIERRE_TREE ? (
                <FileTreePierreSpike
                  files={displayFiles}
                  onOpenFile={(p) => void openFile(workspaceFile(p))}
                  onSplitFile={(p, dir) => void handleSplitFile(p, dir)}
                />
              ) : rows.length === 0 && !pendingEdit ? (
                <p className="px-3 py-4 text-body-sm text-fg-tertiary">
                  {t('workspace.emptyFolder')}
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
                  onOpenFile={(p) => void openFile(workspaceFile(p))}
                  getDragData={(p) => serializeFileDrag(workspaceFile(p))}
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
                  {formatWorkspaceTruncated(summary.files.length)}
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="size-10 rounded-lg bg-surface-2 flex items-center justify-center text-fg-tertiary">
              <FolderSearch size={20} />
            </span>
            <p className="text-body-sm text-fg-secondary">{t('workspace.emptyState.title')}</p>
            <p className="text-caption text-fg-tertiary">
              {t('workspace.emptyState.body')}
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
              {t('workspace.action.openFolder')}
            </button>
          </div>
        )}
      </div>

      {open ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('workspace.resize')}
          onPointerDown={onResizeStart}
          className={cn(
            'absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize',
            'transition-colors duration-fast',
            // In the close zone the seam turns the error/warning token to signal
            // that releasing will dismiss; otherwise standard accent on drag.
            closeZoneActive
              ? 'bg-error'
              : resizing
                ? 'bg-accent'
                : 'bg-transparent hover:bg-accent/60',
          )}
        >
          {/* Wider invisible hit area, kept inside the panel (overflow-hidden). */}
          <span aria-hidden className="absolute inset-y-0 -left-1 right-0" />
          {/* "Release to close" tooltip — only shown in the close zone. Floats
              centered in the seam; overflow-hidden on the aside clips it so it
              never bleeds into the stage area. */}
          {closeZoneActive ? (
            <span
              aria-hidden
              className={cn(
                'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2',
                'whitespace-nowrap px-2 py-1 rounded',
                'bg-surface-2 text-error text-caption pointer-events-none select-none',
              )}
            >
              {t('workspace.releaseToClose')}
            </span>
          ) : null}
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

