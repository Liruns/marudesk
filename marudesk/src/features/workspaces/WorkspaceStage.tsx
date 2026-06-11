import {
  Columns2,
  FolderPlus,
  FolderTree,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  Rows2,
  Server,
  Split,
  Trash2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { SYSTEM_WORKSPACE_ID, type WorkspaceId, type WorkspaceRecord } from '../../../shared/workspace';
import { cn } from '../../lib/cn';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import { Stage } from '../tabs/Stage';
import { TabStrip } from '../tabs/TabStrip';
import { useWorkspaceStore } from '../workspace/store';
import {
  workspaceLeaves,
  type WorkspaceLayoutNode,
  type WorkspaceSplitDir,
} from './layout';
import { NameDialog } from './NameDialog';
import { SshRootDialog } from './SshRootDialog';
import { startLayoutPersistence, useWorkspaceDeckStore } from './store';
import { PeekExplorer } from './WorkspaceStage.parts';

type DeckDialog =
  | { mode: 'create' }
  | { mode: 'create-ssh' }
  | { mode: 'rename'; workspace: WorkspaceRecord };

export function WorkspaceStage() {
  const layout = useWorkspaceDeckStore((s) => s.layout);
  const workspaces = useWorkspaceDeckStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceDeckStore((s) => s.activeWorkspaceId);
  const focusedPaneId = useWorkspaceDeckStore((s) => s.focusedPaneId);
  const refresh = useWorkspaceDeckStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
    // Restore the saved deck split arrangement and keep persisting changes.
    void startLayoutPersistence();
  }, [refresh]);

  useEffect(() => {
    const workspaceId = workspaceIdForFocus(layout, focusedPaneId, activeWorkspaceId);
    const record = workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
    useWorkspaceStore.getState().syncFromWorkspaceRecord(record);
  }, [activeWorkspaceId, focusedPaneId, layout, workspaces]);

  const fallback = layout ?? {
    type: 'leaf' as const,
    id: 'workspace-pane-system',
    workspaceId: SYSTEM_WORKSPACE_ID,
  };

  return (
    <div className="flex-1 min-w-0 min-h-0 flex bg-surface-page">
      <WorkspaceRail workspaces={workspaces} />
      <div className="flex-1 min-w-0 min-h-0 flex">
        <WorkspaceNode node={fallback} workspaces={workspaces} />
      </div>
    </div>
  );
}

function WorkspaceRail({ workspaces }: { workspaces: readonly WorkspaceRecord[] }) {
  const layout = useWorkspaceDeckStore((s) => s.layout);
  const focusedPaneId = useWorkspaceDeckStore((s) => s.focusedPaneId);
  const activeWorkspaceId = useWorkspaceDeckStore((s) => s.activeWorkspaceId);
  const setPaneWorkspace = useWorkspaceDeckStore((s) => s.setPaneWorkspace);
  const setActiveWorkspace = useWorkspaceDeckStore((s) => s.setActiveWorkspace);
  const createWorkspace = useWorkspaceDeckStore((s) => s.createWorkspace);
  const renameWorkspace = useWorkspaceDeckStore((s) => s.renameWorkspace);
  const reindexWorkspace = useWorkspaceDeckStore((s) => s.reindexWorkspace);
  const deleteWorkspace = useWorkspaceDeckStore((s) => s.deleteWorkspace);
  const targetPaneId = focusedPaneId ?? (layout ? workspaceLeaves(layout)[0]?.id : null);

  const [menu, setMenu] = useState<{ workspace: WorkspaceRecord; x: number; y: number } | null>(
    null,
  );
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<DeckDialog | null>(null);

  const openMenu = (event: ReactMouseEvent, workspace: WorkspaceRecord) => {
    event.preventDefault();
    setMenu({ workspace, x: event.clientX, y: event.clientY });
  };

  const menuItems = (workspace: WorkspaceRecord): MenuItem[] => [
    {
      label: 'Rename workspace',
      icon: <Pencil size={14} />,
      onSelect: () => setDialog({ mode: 'rename', workspace }),
    },
    {
      label: 'Reindex workspace',
      icon: <RefreshCw size={14} />,
      onSelect: () => void reindexWorkspace(workspace.id),
    },
    { type: 'separator' },
    {
      label: 'Delete workspace',
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => {
        if (window.confirm(`Delete workspace "${workspace.name}"? This cannot be undone.`)) {
          void deleteWorkspace(workspace.id);
        }
      },
    },
  ];

  return (
    <nav
      aria-label="Workspace rail"
      data-tour="workspace-rail"
      className="chrome-rail w-12 shrink-0 border-r flex flex-col items-center py-2 gap-1"
    >
      {workspaces.map((workspace) => {
        const active = workspace.id === activeWorkspaceId;
        return (
          <button
            key={workspace.id}
            type="button"
            draggable
            aria-label={`Workspace ${workspace.name}`}
            title={`${workspace.name} — drag to split`}
            onClick={() => {
              if (targetPaneId) setPaneWorkspace(targetPaneId, workspace.id);
              void setActiveWorkspace(workspace.id, targetPaneId ?? undefined);
            }}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/x-workspace-id', workspace.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onContextMenu={(event) => openMenu(event, workspace)}
            className={cn(
              'size-8 rounded-md border flex items-center justify-center text-caption font-semibold',
              'transition-colors duration-fast cursor-grab active:cursor-grabbing',
              active
                ? 'border-accent bg-accent-subtle text-accent shadow-highlight'
                : 'border-subtle bg-surface-2 text-fg-secondary hover:text-fg-primary hover:border-default hover:bg-surface-3',
            )}
          >
            {workspaceInitials(workspace.name)}
          </button>
        );
      })}
      <button
        type="button"
        aria-label="New workspace"
        title="New workspace"
        onClick={(event) => setCreateMenu({ x: event.clientX, y: event.clientY })}
        className={cn(
          'size-8 rounded-md border border-dashed border-subtle flex items-center justify-center',
          'text-fg-tertiary hover:text-fg-primary hover:border-default transition-colors duration-fast',
        )}
      >
        <Plus size={16} />
      </button>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.workspace)}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {createMenu ? (
        <ContextMenu
          x={createMenu.x}
          y={createMenu.y}
          items={[
            {
              label: 'New workspace (folder)…',
              icon: <FolderPlus size={14} />,
              onSelect: () => setDialog({ mode: 'create' }),
            },
            {
              label: 'New workspace (SSH folder)…',
              icon: <Server size={14} />,
              onSelect: () => setDialog({ mode: 'create-ssh' }),
            },
          ]}
          onClose={() => setCreateMenu(null)}
        />
      ) : null}
      {dialog?.mode === 'create' ? (
        <NameDialog
          title="New workspace"
          confirmLabel="Choose folder…"
          placeholder="Workspace name (optional)"
          allowEmpty
          onSubmit={(name) => void createWorkspace(name, [])}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.mode === 'create-ssh' ? (
        <SshRootDialog onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.mode === 'rename' ? (
        <NameDialog
          title="Rename workspace"
          confirmLabel="Rename"
          initialValue={dialog.workspace.name}
          onSubmit={(name) => void renameWorkspace(dialog.workspace.id, name)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </nav>
  );
}

function WorkspaceNode({
  node,
  workspaces,
}: {
  node: WorkspaceLayoutNode;
  workspaces: readonly WorkspaceRecord[];
}) {
  if (node.type === 'leaf') {
    const record = workspaces.find((workspace) => workspace.id === node.workspaceId) ?? null;
    return (
      <WorkspacePane
        paneId={node.id}
        workspaceId={node.workspaceId}
        record={record}
      />
    );
  }

  const isRow = node.dir === 'row';
  return (
    <div className={cn('flex min-w-0 min-h-0 w-full h-full', isRow ? 'flex-row' : 'flex-col')}>
      {/* Wrappers are flex containers so a leaf's `WorkspacePane` (a flex-1
          <section>) fills both axes — matching the single-pane parent. Without
          `flex` here the section sits in a plain block, `flex-1` resolves to zero
          height, and the pane's stage (and its web views) collapse to 0px — the
          "split the workspace and the selected tab shows nothing" bug. */}
      <div
        className="min-w-0 min-h-0 relative flex"
        style={isRow ? { width: `${node.ratio * 100}%` } : { height: `${node.ratio * 100}%` }}
      >
        <WorkspaceNode node={node.a} workspaces={workspaces} />
      </div>
      <WorkspaceDivider splitId={node.id} dir={node.dir} />
      <div className="flex-1 min-w-0 min-h-0 relative flex">
        <WorkspaceNode node={node.b} workspaces={workspaces} />
      </div>
    </div>
  );
}

type DropEdge = 'left' | 'right' | 'top' | 'bottom';

function getDropEdge(rect: DOMRect, x: number, y: number): DropEdge {
  const relX = (x - rect.left) / rect.width;
  const relY = (y - rect.top) / rect.height;
  const dLeft = relX;
  const dRight = 1 - relX;
  const dTop = relY;
  const dBottom = 1 - relY;
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min === dLeft) return 'left';
  if (min === dRight) return 'right';
  if (min === dTop) return 'top';
  return 'bottom';
}

const EDGE_DIR: Record<DropEdge, WorkspaceSplitDir> = {
  left: 'row',
  right: 'row',
  top: 'col',
  bottom: 'col',
};
const EDGE_SIDE: Record<DropEdge, 'before' | 'after'> = {
  left: 'before',
  right: 'after',
  top: 'before',
  bottom: 'after',
};

function WorkspacePane({
  paneId,
  workspaceId,
  record,
}: {
  paneId: string;
  workspaceId: WorkspaceId;
  record: WorkspaceRecord | null;
}) {
  const layout = useWorkspaceDeckStore((s) => s.layout);
  const focusedPaneId = useWorkspaceDeckStore((s) => s.focusedPaneId);
  const focusPane = useWorkspaceDeckStore((s) => s.focusPane);
  const setActiveWorkspace = useWorkspaceDeckStore((s) => s.setActiveWorkspace);
  const addRoot = useWorkspaceDeckStore((s) => s.addRoot);
  const reindexWorkspace = useWorkspaceDeckStore((s) => s.reindexWorkspace);
  const splitFocusedPane = useWorkspaceDeckStore((s) => s.splitFocusedPane);
  const closePane = useWorkspaceDeckStore((s) => s.closePane);
  const [peekOpen, setPeekOpen] = useState(false);
  const [splitPickerOpen, setSplitPickerOpen] = useState(false);
  const [dropEdge, setDropEdge] = useState<DropEdge | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const focused = focusedPaneId === paneId;
  const paneCount = layout ? workspaceLeaves(layout).length : 1;

  const doSplit = useCallback(
    (wsId: WorkspaceId, dir: WorkspaceSplitDir, side: 'before' | 'after' = 'after') => {
      focusPane(paneId);
      splitFocusedPane(wsId, dir, side);
    },
    [focusPane, paneId, splitFocusedPane],
  );

  const onDragOver = useCallback((e: ReactDragEvent) => {
    if (!e.dataTransfer.types.includes('text/x-workspace-id')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const rect = sectionRef.current?.getBoundingClientRect();
    if (rect) setDropEdge(getDropEdge(rect, e.clientX, e.clientY));
  }, []);

  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      const wsId = e.dataTransfer.getData('text/x-workspace-id') as WorkspaceId;
      setDropEdge(null);
      if (!wsId) return;
      e.preventDefault();
      const rect = sectionRef.current?.getBoundingClientRect();
      if (!rect) return;
      const edge = getDropEdge(rect, e.clientX, e.clientY);
      doSplit(wsId, EDGE_DIR[edge], EDGE_SIDE[edge]);
    },
    [doSplit],
  );

  return (
    <section
      ref={sectionRef}
      className={cn(
        'relative flex-1 min-w-0 min-h-0 flex flex-col bg-surface-page',
        'ring-inset transition-shadow duration-fast',
        focused ? 'ring-1 ring-accent/50 shadow-focus-accent' : 'ring-0',
      )}
      aria-label={record?.name ?? 'System workspace'}
      onMouseDown={() => {
        if (!focused && record) void setActiveWorkspace(record.id, paneId);
        else focusPane(paneId);
      }}
      onDragOver={onDragOver}
      onDragLeave={() => setDropEdge(null)}
      onDrop={onDrop}
    >
      <header className="chrome-header h-10 shrink-0 flex items-center gap-2">
        <div className="min-w-[140px] max-w-[230px] pl-2.5 flex items-center gap-2.5">
          <span
            className={cn(
              'size-7 shrink-0 rounded-md border flex items-center justify-center text-caption font-semibold',
              focused
                ? 'border-accent/60 bg-accent-subtle text-accent'
                : 'border-subtle bg-surface-2 text-fg-secondary',
            )}
          >
            {record ? workspaceInitials(record.name) : <PanelLeft size={14} className="text-fg-tertiary" />}
          </span>
          <div className="min-w-0">
            <div className="truncate text-caption font-medium text-fg-primary">
              {record?.name ?? 'System'}
            </div>
            <div className="flex items-center gap-2 text-caption text-fg-tertiary tabular-nums">
              {record ? (
                <>
                  <span className="inline-flex items-center gap-1" title={`${record.roots.length} folder root(s)`}>
                    <FolderTree size={11} aria-hidden />
                    {record.roots.length}
                  </span>
                  {record.roots.some((r) => r.connection?.kind === 'ssh') ? (
                    <span className="inline-flex items-center gap-1 text-accent" title="Includes an SSH folder">
                      <Server size={11} aria-hidden />
                      SSH
                    </span>
                  ) : null}
                </>
              ) : (
                'No folder roots'
              )}
            </div>
          </div>
        </div>
        <TabStrip workspaceId={workspaceId} />
        <div className="shrink-0 flex items-center gap-1 pr-2">
          {record ? (
            <PaneButton label="Add folder to workspace" onClick={() => void addRoot(record.id)}>
              <FolderPlus size={15} />
            </PaneButton>
          ) : null}
          {record ? (
            <PaneButton
              label="Reindex workspace"
              onClick={() => void reindexWorkspace(record.id)}
            >
              <RefreshCw size={15} />
            </PaneButton>
          ) : null}
          <PaneButton label="Peek Explorer" onClick={() => setPeekOpen((open) => !open)}>
            <FolderTree size={15} />
          </PaneButton>
          <div className="relative">
            <PaneButton
              label="Split workspace"
              onClick={() => setSplitPickerOpen((v) => !v)}
            >
              <Split size={15} />
            </PaneButton>
            {splitPickerOpen ? (
              <SplitPicker
                currentWorkspaceId={workspaceId}
                onSplit={(wsId, dir) => {
                  doSplit(wsId, dir);
                  setSplitPickerOpen(false);
                }}
                onClose={() => setSplitPickerOpen(false)}
              />
            ) : null}
          </div>
          {paneCount > 1 ? (
            <PaneButton label="Close workspace pane" onClick={() => closePane(paneId)}>
              <X size={15} />
            </PaneButton>
          ) : null}
        </div>
      </header>
      <div className="flex-1 min-w-0 min-h-0 flex">
        <Stage workspaceId={workspaceId} />
      </div>
      {peekOpen && record ? (
        <PeekExplorer
          record={record}
          onClose={() => setPeekOpen(false)}
        />
      ) : null}
      {dropEdge ? <DropOverlay edge={dropEdge} /> : null}
    </section>
  );
}

function WorkspaceDivider({
  splitId,
  dir,
}: {
  splitId: string;
  dir: WorkspaceSplitDir;
}) {
  const resize = useWorkspaceDeckStore((s) => s.resizeSplit);
  const [active, setActive] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isRow = dir === 'row';

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = ref.current;
    const container = handle?.parentElement;
    if (!handle || !container) return;
    setActive(true);
    handle.setPointerCapture(event.pointerId);

    const onMove = (move: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const ratio = isRow
        ? (move.clientX - rect.left) / rect.width
        : (move.clientY - rect.top) / rect.height;
      resize(splitId, ratio);
    };
    const onDone = () => {
      setActive(false);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('lostpointercapture', onDone);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('lostpointercapture', onDone);
  };

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={isRow ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
      className={cn(
        'relative shrink-0 z-20',
        isRow ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
        active ? 'bg-accent shadow-focus-accent' : 'bg-subtle hover:bg-accent/70',
        'transition-colors duration-fast',
      )}
    />
  );
}


function PaneButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="chrome-icon-button size-7"
    >
      {children}
    </button>
  );
}

function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'W';
  const first = words[0]?.[0] ?? 'W';
  const second = words.length > 1 ? words[1]?.[0] : words[0]?.[1];
  return `${first}${second ?? ''}`.toUpperCase();
}

function workspaceIdForFocus(
  layout: WorkspaceLayoutNode | null,
  focusedPaneId: string | null,
  activeWorkspaceId: WorkspaceId | null,
): WorkspaceId | null {
  if (!layout) return activeWorkspaceId;
  const leaves = workspaceLeaves(layout);
  const focused = focusedPaneId
    ? leaves.find((leaf) => leaf.id === focusedPaneId)
    : undefined;
  return focused?.workspaceId ?? activeWorkspaceId ?? leaves[0]?.workspaceId ?? null;
}

function SplitPicker({
  currentWorkspaceId,
  onSplit,
  onClose,
}: {
  currentWorkspaceId: WorkspaceId;
  onSplit: (workspaceId: WorkspaceId, dir: WorkspaceSplitDir) => void;
  onClose: () => void;
}) {
  const workspaces = useWorkspaceDeckStore((s) => s.workspaces);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [onClose]);

  const sorted = [
    ...workspaces.filter((w) => w.id === currentWorkspaceId),
    ...workspaces.filter((w) => w.id !== currentWorkspaceId),
  ];

  return (
    <div
      ref={ref}
      className="chrome-popover absolute right-0 top-8 z-50 w-[220px] rounded-lg overflow-hidden shadow-lg"
    >
      <div className="chrome-header h-8 flex items-center px-3 text-caption font-medium text-fg-secondary">
        Split with workspace
      </div>
      <div className="py-1 max-h-[240px] overflow-y-auto">
        {sorted.map((ws) => (
          <div
            key={ws.id}
            className={cn(
              'flex items-center h-8 px-3 gap-2 hover:bg-surface-3 transition-colors duration-fast',
              ws.id === currentWorkspaceId && 'bg-surface-2',
            )}
          >
            <span
              className={cn(
                'size-5 shrink-0 rounded border flex items-center justify-center text-[10px] font-semibold',
                ws.id === currentWorkspaceId
                  ? 'border-accent/60 bg-accent-subtle text-accent'
                  : 'border-subtle bg-surface-2 text-fg-secondary',
              )}
            >
              {workspaceInitials(ws.name)}
            </span>
            <span className="flex-1 truncate text-body-sm text-fg-primary">
              {ws.name}
              {ws.id === currentWorkspaceId ? (
                <span className="text-fg-tertiary"> (current)</span>
              ) : null}
            </span>
            <button
              type="button"
              title="Split right"
              onClick={() => onSplit(ws.id, 'row')}
              className="chrome-icon-button size-6"
            >
              <Columns2 size={13} />
            </button>
            <button
              type="button"
              title="Split down"
              onClick={() => onSplit(ws.id, 'col')}
              className="chrome-icon-button size-6"
            >
              <Rows2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const DROP_OVERLAY_STYLE: Record<DropEdge, string> = {
  left: 'inset-y-0 left-0 w-1/2',
  right: 'inset-y-0 right-0 w-1/2',
  top: 'inset-x-0 top-0 h-1/2',
  bottom: 'inset-x-0 bottom-0 h-1/2',
};

function DropOverlay({ edge }: { edge: DropEdge }) {
  return (
    <div className="absolute inset-0 z-30 pointer-events-none">
      <div
        className={cn(
          'absolute bg-accent/15 border-2 border-accent/40 rounded-md transition-all duration-fast',
          DROP_OVERLAY_STYLE[edge],
        )}
      />
    </div>
  );
}
