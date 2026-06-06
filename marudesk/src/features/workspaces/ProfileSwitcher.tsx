import { Check, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { DEFAULT_PROFILE_ID, type ProfilesState } from '../../../shared/profiles';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import { NameDialog } from './NameDialog';

type ProfileDialog = { mode: 'create' } | { mode: 'rename'; id: string; name: string };

/**
 * Profile switcher at the top of the workspace rail. Lists profiles, switches
 * (which relaunches into that profile's isolated data set), and creates / renames
 * / deletes profiles. Hardcoded English labels match the workspace context menu.
 */
export function ProfileSwitcher() {
  const [state, setState] = useState<ProfilesState | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<ProfileDialog | null>(null);

  const load = (): void => {
    void window.marudesk.invoke('profiles:list').then(setState);
  };
  useEffect(load, []);

  const active = state?.profiles.find((p) => p.id === state.activeProfileId) ?? null;

  const openMenu = (event: ReactMouseEvent): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.right + 4, y: rect.top });
  };

  const items = (): MenuItem[] => {
    const list = state?.profiles ?? [];
    const activeId = state?.activeProfileId;
    const out: MenuItem[] = list.map((p) => ({
      label: p.name,
      icon: p.id === activeId ? <Check size={14} /> : <span className="size-3.5" />,
      onSelect: () => {
        if (p.id !== activeId) void window.marudesk.invoke('profiles:switch', p.id);
      },
    }));
    out.push({ type: 'separator' });
    out.push({
      label: 'New profile…',
      icon: <Plus size={14} />,
      onSelect: () => setDialog({ mode: 'create' }),
    });
    if (active) {
      out.push({
        label: 'Rename profile…',
        icon: <Pencil size={14} />,
        onSelect: () => setDialog({ mode: 'rename', id: active.id, name: active.name }),
      });
    }
    for (const p of list) {
      if (p.id === DEFAULT_PROFILE_ID || p.id === activeId) continue;
      out.push({
        label: `Delete "${p.name}"`,
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => {
          if (window.confirm(`Delete profile "${p.name}"? Its data is permanently removed.`)) {
            void window.marudesk.invoke('profiles:delete', p.id).then(setState);
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
        aria-label={`Profile: ${active?.name ?? 'Default'}`}
        title={`Profile: ${active?.name ?? 'Default'}`}
        onClick={openMenu}
        className="size-8 rounded-full border border-subtle bg-surface-2 text-fg-secondary hover:text-fg-primary hover:border-default hover:bg-surface-3 flex items-center justify-center transition-colors duration-fast"
      >
        <UserRound size={16} aria-hidden />
      </button>
      <div className="w-6 h-px bg-subtle my-1" aria-hidden />

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items()}
          onClose={() => {
            setMenu(null);
            load();
          }}
        />
      ) : null}
      {dialog?.mode === 'create' ? (
        <NameDialog
          title="New profile"
          confirmLabel="Create"
          placeholder="Profile name"
          onSubmit={(name) => {
            void window.marudesk
              .invoke('profiles:create', name)
              .then((meta) => window.marudesk.invoke('profiles:switch', meta.id));
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.mode === 'rename' ? (
        <NameDialog
          title="Rename profile"
          confirmLabel="Rename"
          initialValue={dialog.name}
          onSubmit={(name) => {
            void window.marudesk.invoke('profiles:rename', { id: dialog.id, name }).then(setState);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}
