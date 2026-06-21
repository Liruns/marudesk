import { Check, ChevronDown, FolderPlus, Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { SYSTEM_WORKSPACE_ID, type WorkspaceId } from '../../../shared/workspace';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { NameDialog } from './NameDialog';
import { useWorkspaceDeckStore } from './store';

type WorkspaceDialog = { mode: 'create' } | { mode: 'rename'; id: WorkspaceId; name: string };

/** A workspace pending in-app delete confirmation. */
type PendingDelete = { id: WorkspaceId; name: string };

/**
 * Workspace switcher in the title bar — the Mission Control home for workspace
 * management after the redesign removed the Workspace rail. Lists workspaces,
 * switches the active one, and creates / renames / deletes / adds-folder, all via
 * the surviving deck store actions (workspaces:* IPC). Sits beside the
 * ProfileSwitcher, which manages *profiles* (isolated userData), not workspaces.
 */
export function WorkspaceSwitcher() {
  const { t } = useI18n();
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
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

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
      label: t('workspaces.menu.create'),
      icon: <Plus size={14} />,
      onSelect: () => setDialog({ mode: 'create' }),
    });
    if (activeManageable) {
      out.push({
        label: t('workspaces.menu.rename'),
        icon: <Pencil size={14} />,
        onSelect: () => setDialog({ mode: 'rename', id: activeManageable.id, name: activeManageable.name }),
      });
      out.push({
        label: t('workspaces.menu.addFolder'),
        icon: <FolderPlus size={14} />,
        onSelect: () => void addRoot(activeManageable.id),
      });
    }
    for (const w of real) {
      if (w.id === activeWorkspaceId) continue;
      out.push({
        label: t('workspaces.menu.delete').replace('{name}', w.name),
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => setPendingDelete({ id: w.id, name: w.name }),
      });
    }
    return out;
  };

  const triggerLabel = t('workspaces.trigger.label').replace(
    '{name}',
    active?.name ?? t('workspaces.trigger.none'),
  );

  return (
    <>
      <button
        type="button"
        data-tour="workspace"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title={t('workspaces.trigger.title').replace('{label}', triggerLabel)}
        onClick={openMenu}
        className="no-drag self-center inline-flex items-center gap-1.5 h-7 rounded-md border border-subtle bg-surface-2 pl-2 pr-1.5 text-caption text-fg-secondary hover:text-fg-primary hover:border-default hover:bg-surface-3 transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Layers size={14} aria-hidden />
        <span className="max-w-[140px] truncate font-medium">
          {active?.name ?? t('workspaces.trigger.empty')}
        </span>
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
          title={t('workspaces.dialog.create.title')}
          confirmLabel={t('workspaces.dialog.create.confirm')}
          placeholder={t('workspaces.dialog.create.placeholder')}
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
          title={t('workspaces.dialog.rename.title')}
          confirmLabel={t('workspaces.dialog.rename.confirm')}
          initialValue={dialog.name}
          onSubmit={(name) => void renameWorkspace(dialog.id, name)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {pendingDelete ? (
        <DeleteConfirm
          name={pendingDelete.name}
          onConfirm={() => {
            void deleteWorkspace(pendingDelete.id);
            setPendingDelete(null);
          }}
          onClose={() => setPendingDelete(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Tokenized in-app confirm for the destructive delete-workspace action. Replaces
 * the native `window.confirm` (untranslated, blocking, un-driveable in tests) and
 * mirrors {@link NameDialog}: portaled, hides the compositing browser view while
 * open, and dismisses on Escape / backdrop click.
 */
function DeleteConfirm({
  name,
  onConfirm,
  onClose,
}: {
  name: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // Trap Tab/Shift+Tab inside the confirm card so focus can't escape to the
  // chrome behind the backdrop (the same hook PaletteOverlay uses).
  const cardRef = useFocusTrap<HTMLDivElement>();
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    void window.marudesk.invoke('browser:set-visible', false);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      void window.marudesk.invoke('browser:set-visible', true);
    };
  }, [onClose]);

  const title = t('workspaces.delete.title').replace('{name}', name);

  // z-[80]: above the palette scrim (z-[60]) and toast (z-[70]) so this modal
  // confirm sits on top of the R10 z-ladder; still below the Tour (z-[100]).
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40"
      onMouseDown={onClose}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid="workspace-delete-confirm"
        onMouseDown={(event) => event.stopPropagation()}
        className="w-[360px] rounded-lg bg-surface-1 border border-default shadow-lifted p-4 flex flex-col gap-2"
      >
        <h2 className="text-body font-semibold text-fg-primary">{title}</h2>
        <p className="text-body-sm text-fg-secondary">{t('workspaces.delete.body')}</p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded-md text-body-sm text-fg-secondary hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast"
          >
            {t('workspaces.delete.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              'h-8 px-3 rounded-md text-body-sm font-medium bg-error text-white',
              'transition-opacity duration-fast hover:opacity-90',
            )}
          >
            {t('workspaces.delete.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
