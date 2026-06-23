import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { FolderOpen, FolderPlus, Trash2 } from 'lucide-react';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import { cn } from '../../lib/cn';
import type { WorkspaceRecord, WorkspaceRootId } from '../../../shared/workspace';
import { useI18n } from '../../i18n/useI18n';

export function WorkspaceRootsBar({
  record,
  activeRootId,
  onSelectRoot,
  onAddRoot,
  onRemoveRoot,
}: {
  record: WorkspaceRecord;
  activeRootId: WorkspaceRootId | null;
  onSelectRoot: (rootId: WorkspaceRootId) => void;
  onAddRoot: () => void;
  onRemoveRoot: (rootId: WorkspaceRootId) => void;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{
    root: WorkspaceRecord['roots'][number];
    x: number;
    y: number;
  } | null>(null);

  const openRootMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    root: WorkspaceRecord['roots'][number],
  ) => {
    event.preventDefault();
    setMenu({ root, x: event.clientX, y: event.clientY });
  };

  const menuItems = (root: WorkspaceRecord['roots'][number]): MenuItem[] => [
    {
      label: `${t('workspace.roots.useRoot')} ${root.name}`,
      icon: <FolderOpen size={14} />,
      onSelect: () => onSelectRoot(root.id),
    },
    {
      label: t('workspace.roots.addFolder'),
      icon: <FolderPlus size={14} />,
      onSelect: onAddRoot,
    },
    { type: 'separator' },
    {
      label: t('workspace.roots.removeFolder'),
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: record.roots.length <= 1,
      onSelect: () => {
        if (window.confirm(t('workspace.roots.removeConfirm'))) {
          onRemoveRoot(root.id);
        }
      },
    },
  ];

  return (
    <div className="shrink-0 px-2 py-1.5 border-b border-subtle flex items-center gap-1 overflow-x-auto">
      {record.roots.map((root) => {
        const active = root.id === activeRootId;
        return (
          <button
            key={root.id}
            type="button"
            aria-label={`Use root ${root.name}`}
            title={root.root}
            onClick={() => onSelectRoot(root.id)}
            onContextMenu={(event) => openRootMenu(event, root)}
            className={cn(
              'h-6 min-w-0 inline-flex items-center gap-1.5 px-2 rounded text-caption',
              'border transition-colors duration-fast',
              active
                ? 'border-accent bg-accent-subtle text-accent'
                : 'border-subtle bg-surface-2 text-fg-secondary hover:text-fg-primary hover:border-default',
            )}
          >
            <span className="truncate max-w-[88px]">{root.name}</span>
            <span className="tabular-nums text-fg-tertiary">{root.files.length}</span>
          </button>
        );
      })}
      <button
        type="button"
        aria-label={t('workspace.roots.addFolder')}
        title={t('workspace.roots.addFolder')}
        onClick={onAddRoot}
        className={cn(
          'size-6 shrink-0 rounded border border-subtle bg-surface-2',
          'flex items-center justify-center text-fg-tertiary',
          'hover:text-fg-primary hover:border-default transition-colors duration-fast',
        )}
      >
        <FolderPlus size={14} />
      </button>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.root)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

export function IconButton({
  label,
  onClick,
  disabled = false,
  active = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Sticky-on state (e.g. a view toggle) — tints the button with the accent. */
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'size-6 rounded flex items-center justify-center shrink-0',
        'transition-colors duration-fast',
        disabled
          ? 'text-fg-disabled cursor-not-allowed'
          : active
            ? 'bg-accent-subtle text-accent'
            : 'text-fg-tertiary hover:text-fg-primary hover:bg-surface-2',
      )}
    >
      {children}
    </button>
  );
}
