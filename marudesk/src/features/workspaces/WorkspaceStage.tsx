import {
  Columns2,
  FolderPlus,
  FolderTree,
  PanelLeft,
  Search,
  X,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { SYSTEM_WORKSPACE_ID, type WorkspaceId, type WorkspaceRecord } from '../../../shared/workspace';
import { cn } from '../../lib/cn';
import { useEditorStore } from '../editor/store';
import { Stage } from '../tabs/Stage';
import { TabStrip } from '../tabs/TabStrip';
import { useWorkspaceStore } from '../workspace/store';
import {
  workspaceLeaves,
  type WorkspaceLayoutNode,
  type WorkspaceSplitDir,
} from './layout';
import { useWorkspaceDeckStore } from './store';

export function WorkspaceStage() {
  const layout = useWorkspaceDeckStore((s) => s.layout);
  const workspaces = useWorkspaceDeckStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceDeckStore((s) => s.activeWorkspaceId);
  const focusedPaneId = useWorkspaceDeckStore((s) => s.focusedPaneId);
  const refresh = useWorkspaceDeckStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
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
  const targetPaneId = focusedPaneId ?? (layout ? workspaceLeaves(layout)[0]?.id : null);

  if (workspaces.length === 0) return null;

  return (
    <nav
      aria-label="Workspace rail"
      className="w-12 shrink-0 border-r border-subtle bg-surface-1 flex flex-col items-center py-2 gap-1"
    >
      {workspaces.map((workspace) => {
        const active = workspace.id === activeWorkspaceId;
        return (
          <button
            key={workspace.id}
            type="button"
            aria-label={`Workspace ${workspace.name}`}
            title={workspace.name}
            onClick={() => {
              if (targetPaneId) setPaneWorkspace(targetPaneId, workspace.id);
              void setActiveWorkspace(workspace.id, targetPaneId ?? undefined);
            }}
            className={cn(
              'size-8 rounded-md border flex items-center justify-center text-caption font-semibold',
              'transition-colors duration-fast',
              active
                ? 'border-accent bg-accent-subtle text-accent'
                : 'border-subtle bg-surface-2 text-fg-secondary hover:text-fg-primary hover:border-default',
            )}
          >
            {workspaceInitials(workspace.name)}
          </button>
        );
      })}
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
      <div
        className="min-w-0 min-h-0 relative"
        style={isRow ? { width: `${node.ratio * 100}%` } : { height: `${node.ratio * 100}%` }}
      >
        <WorkspaceNode node={node.a} workspaces={workspaces} />
      </div>
      <WorkspaceDivider splitId={node.id} dir={node.dir} />
      <div className="flex-1 min-w-0 min-h-0 relative">
        <WorkspaceNode node={node.b} workspaces={workspaces} />
      </div>
    </div>
  );
}

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
  const splitFocusedPane = useWorkspaceDeckStore((s) => s.splitFocusedPane);
  const closePane = useWorkspaceDeckStore((s) => s.closePane);
  const [peekOpen, setPeekOpen] = useState(false);
  const focused = focusedPaneId === paneId;
  const paneCount = layout ? workspaceLeaves(layout).length : 1;

  const split = (dir: WorkspaceSplitDir) => {
    focusPane(paneId);
    splitFocusedPane(workspaceId, dir);
  };

  return (
    <section
      className={cn(
        'relative flex-1 min-w-0 min-h-0 flex flex-col bg-surface-page',
        'ring-inset transition-shadow duration-fast',
        focused ? 'ring-1 ring-accent/50' : 'ring-0',
      )}
      aria-label={record?.name ?? 'System workspace'}
      onMouseDown={() => {
        if (!focused && record) void setActiveWorkspace(record.id, paneId);
        else focusPane(paneId);
      }}
    >
      <header className="h-10 shrink-0 flex items-center gap-2 border-b border-subtle bg-surface-1">
        <div className="min-w-[128px] max-w-[220px] pl-3 flex items-center gap-2">
          <span className="size-6 rounded-md bg-surface-2 border border-subtle flex items-center justify-center text-fg-tertiary">
            <PanelLeft size={14} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-caption font-medium text-fg-primary">
              {record?.name ?? 'System'}
            </div>
            <div className="truncate text-caption text-fg-tertiary tabular-nums">
              {record ? `${record.roots.length} roots` : 'No folder roots'}
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
          <PaneButton label="Peek Explorer" onClick={() => setPeekOpen((open) => !open)}>
            <FolderTree size={15} />
          </PaneButton>
          <PaneButton label="Split workspace right" onClick={() => split('row')}>
            <Columns2 size={15} />
          </PaneButton>
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
        active ? 'bg-accent' : 'bg-subtle hover:bg-accent/70',
        'transition-colors duration-fast',
      )}
    />
  );
}

function PeekExplorer({
  record,
  onClose,
}: {
  record: WorkspaceRecord;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const openFile = useEditorStore((s) => s.openFile);
  const lower = query.trim().toLowerCase();
  const roots = useMemo(
    () =>
      record.roots.map((root) => ({
        root,
        files: root.files
          .filter((file) => !lower || file.path.toLowerCase().includes(lower))
          .slice(0, 48),
      })),
    [record.roots, lower],
  );

  return (
    <div className="absolute right-3 top-12 z-40 w-[360px] max-h-[70%] flex flex-col rounded-lg bg-surface-1 border border-default shadow-lifted overflow-hidden">
      <div className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-subtle">
        <Search size={15} className="text-fg-tertiary" />
        <input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          autoFocus
          placeholder="Filter files"
          className="min-w-0 flex-1 bg-transparent text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
        />
        <button
          type="button"
          aria-label="Close Peek Explorer"
          onClick={onClose}
          className="size-6 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto py-2">
        {roots.map(({ root, files }) => (
          <div key={root.id} className="pb-2">
            <div className="px-3 h-6 flex items-center gap-2 text-caption font-medium text-fg-tertiary uppercase">
              <FolderTree size={13} />
              <span className="truncate">{root.name}</span>
              <span className="ml-auto tabular-nums">{files.length}</span>
            </div>
            {files.map((file) => (
              <button
                key={`${root.id}:${file.path}`}
                type="button"
                onClick={() => {
                  void openFile({
                    workspaceId: record.id,
                    rootId: root.id,
                    path: file.path,
                  });
                  onClose();
                }}
                className="w-full h-7 flex items-center gap-2 px-5 text-left text-body-sm text-fg-secondary hover:text-fg-primary hover:bg-surface-2"
                title={`${root.name} / ${file.path}`}
              >
                <span className="truncate">{file.path}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
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
      className="size-7 rounded-md flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast"
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
