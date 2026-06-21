import { Check, ChevronDown, FolderPlus, Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { SYSTEM_WORKSPACE_ID, type WorkspaceId } from '../../../shared/workspace';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import { NameDialog } from './NameDialog';
import { useWorkspaceDeckStore } from './store';

type WorkspaceDialog = { mode: 'create' } | { mode: 'rename'; id: WorkspaceId; name: string };

/**
 * Workspace switcher in the title bar — the Mission Control home for workspace
 * management after the redesign removed the Workspace rail. Lists workspaces,
 * switches the active one, and creates / renames / deletes / adds-folder, all via
 * the surviving deck store actions (workspaces:* IPC). Sits beside the
 * ProfileSwitcher, which manages *profiles* (isolated userData), not workspaces.
 */
export function WorkspaceSwitcher() {
  const workspaces = useWorkspaceDeckStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceDeckStore((s) => s.activeWorkspaceId);
  const refresh = useWorkspaceDeckStore((s) => s.refresh);
  const setActiveWorkspace = useWorkspaceDeckStore((s) => s.setActiveWorkspace);
  const createWorkspace = useWorkspaceDeckStore((s) => s.createWorkspace);
  const renameWorkspace = useWorkspaceDeckStore((s) => s.renameWorkspace);
  const deleteWorkspace = useWorkspaceDeckStore((s) => s.deleteWorkspace);
  const addRoot = useWorkspaceDeckStore((s) => s.addRoot);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<WorkspaceDialog | null>(null);

  // Ensure the list is populated (the deck store loads lazily elsewhere).
  useEffect(() => {
    if (workspaces.length === 0) void refresh();
  }, [workspaces.length, refresh]);

  // Real (non-system) workspaces are the manageable set.
  const real = workspaces.filter((w) => w.id !== SYSTEM_WORKSPACE_ID);
  const active = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const activeManageable = active && active.id !== SYSTEM_WORKSPACE_ID ? active : null;

  const openMenu = (event: ReactMouseEvent): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  const items = (): MenuItem[] => {
    const out: MenuItem[] = real.map((w) => ({
      label: w.name,
      icon: w.id === activeWorkspaceId ? <Check size={14} /> : <span className="size-3.5" />,
      onSelect: () => {
        if (w.id !== activeWorkspaceId) void setActiveWorkspace(w.id);
      },
    }));
    if (real.length > 0) out.push({ type: 'separator' });
    out.push({
      label: 'New workspace…',
      icon: <Plus size={14} />,
      onSelect: () => setDialog({ mode: 'create' }),
    });
    if (activeManageable) {
      out.push({
        label: 'Rename workspace…',
        icon: <Pencil size={14} />,
        onSelect: () => setDialog({ mode: 'rename', id: activeManageable.id, name: activeManageable.name }),
      });
      out.push({
        label: 'Add folder…',
        icon: <FolderPlus size={14} />,
        onSelect: () => void addRoot(activeManageable.id),
      });
    }
    for (const w of real) {
      if (w.id === activeWorkspaceId) continue;
      out.push({
        label: `Delete "${w.name}"`,
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => {
          if (window.confirm(`Delete workspace "${w.name}"? This removes it from Maru (your files are not deleted).`)) {
            void deleteWorkspace(w.id);
          }
        },
      });
    }
    return out;
  };

  return (
    <>
      <button
        type="button"
        data-tour="workspace"
        aria-label={`Workspace: ${active?.name ?? 'None'}`}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title={`Workspace: ${active?.name ?? 'None'} — switch or manage workspaces`}
        onClick={openMenu}
        className="no-drag self-center inline-flex items-center gap-1.5 h-7 rounded-md border border-subtle bg-surface-2 pl-2 pr-1.5 text-caption text-fg-secondary hover:text-fg-primary hover:border-default hover:bg-surface-3 transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Layers size={14} aria-hidden />
        <span className="max-w-[140px] truncate font-medium">{active?.name ?? 'No workspace'}</span>
        <ChevronDown size={13} aria-hidden className="text-fg-tertiary" />
      </button>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items()}
          onClose={() => {
            setMenu(null);
            void refresh();
          }}
        />
      ) : null}
      {dialog?.mode === 'create' ? (
        <NameDialog
          title="New workspace"
          confirmLabel="Choose folder…"
          placeholder="Workspace name (optional)"
          allowEmpty
          onSubmit={(name) => {
            // Empty roots → main pops a native folder picker and seeds the workspace
            // with the chosen folder, then makes it active.
            void createWorkspace(name, []).then((record) => {
              if (record) void setActiveWorkspace(record.id);
            });
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.mode === 'rename' ? (
        <NameDialog
          title="Rename workspace"
          confirmLabel="Rename"
          initialValue={dialog.name}
          onSubmit={(name) => void renameWorkspace(dialog.id, name)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}
