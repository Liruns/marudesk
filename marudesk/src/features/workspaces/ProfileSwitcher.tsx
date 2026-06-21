import { Check, ChevronDown, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_PROFILE_ID, type ProfilesState } from '../../../shared/profiles';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { NameDialog } from './NameDialog';

type ProfileDialog = { mode: 'create' } | { mode: 'rename'; id: string; name: string };

/** A profile pending in-app delete confirmation. */
type PendingDelete = { id: string; name: string };

/**
 * Profile switcher at the top of the workspace rail. Lists profiles, switches
 * (applied LIVE — the main process repoints userData and reloads the renderer
 * into that profile's isolated data set, without restarting the app), and creates
 * / renames / deletes profiles. Mirrors the {@link WorkspaceSwitcher} treatment:
 * fully translated labels and an in-app tokenized delete confirm in place of the
 * blocking native `window.confirm`.
 */
export function ProfileSwitcher() {
  const { t } = useI18n();
  const [state, setState] = useState<ProfilesState | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<ProfileDialog | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  const load = (): void => {
    void window.marudesk.invoke('profiles:list').then(setState);
  };
  useEffect(load, []);

  const active = state?.profiles.find((p) => p.id === state.activeProfileId) ?? null;
  const activeName = active?.name ?? t('profiles.trigger.default');

  const openMenu = (event: ReactMouseEvent): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.bottom + 4 });
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
      label: t('profiles.menu.create'),
      icon: <Plus size={14} />,
      onSelect: () => setDialog({ mode: 'create' }),
    });
    if (active) {
      out.push({
        label: t('profiles.menu.rename'),
        icon: <Pencil size={14} />,
        onSelect: () => setDialog({ mode: 'rename', id: active.id, name: active.name }),
      });
    }
    for (const p of list) {
      if (p.id === DEFAULT_PROFILE_ID || p.id === activeId) continue;
      out.push({
        label: t('profiles.menu.delete').replace('{name}', p.name),
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => setPendingDelete({ id: p.id, name: p.name }),
      });
    }
    return out;
  };

  const triggerLabel = t('profiles.trigger.label').replace('{name}', activeName);

  return (
    <>
      <button
        type="button"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title={t('profiles.trigger.title').replace('{name}', activeName)}
        onClick={openMenu}
        className="no-drag self-center inline-flex min-w-0 items-center gap-1.5 h-7 rounded-md border border-subtle bg-surface-2 pl-2 pr-1.5 text-caption text-fg-secondary hover:text-fg-primary hover:border-default hover:bg-surface-3 transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <UserRound size={14} aria-hidden />
        <span className="max-w-[140px] truncate font-medium">{activeName}</span>
        <ChevronDown size={13} aria-hidden className="text-fg-tertiary" />
      </button>

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
          title={t('profiles.dialog.create.title')}
          confirmLabel={t('profiles.dialog.create.confirm')}
          cancelLabel={t('profiles.delete.cancel')}
          placeholder={t('profiles.dialog.create.placeholder')}
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
          title={t('profiles.dialog.rename.title')}
          confirmLabel={t('profiles.dialog.rename.confirm')}
          cancelLabel={t('profiles.delete.cancel')}
          initialValue={dialog.name}
          onSubmit={(name) => {
            void window.marudesk.invoke('profiles:rename', { id: dialog.id, name }).then(setState);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {pendingDelete ? (
        <DeleteConfirm
          name={pendingDelete.name}
          onConfirm={() => {
            void window.marudesk.invoke('profiles:delete', pendingDelete.id).then(setState);
            setPendingDelete(null);
          }}
          onClose={() => setPendingDelete(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Tokenized in-app confirm for the destructive delete-profile action. Replaces
 * the native `window.confirm` (untranslated, blocking, un-driveable in tests) and
 * mirrors {@link NameDialog} / the WorkspaceSwitcher confirm: portaled, hides the
 * compositing browser view while open, and dismisses on Escape / backdrop click.
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

  const title = t('profiles.delete.title').replace('{name}', name);

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
        data-testid="profile-delete-confirm"
        onMouseDown={(event) => event.stopPropagation()}
        className="w-[360px] rounded-lg bg-surface-1 border border-default shadow-lifted p-4 flex flex-col gap-2"
      >
        <h2 className="text-body font-semibold text-fg-primary">{title}</h2>
        <p className="text-body-sm text-fg-secondary">{t('profiles.delete.body')}</p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded-md text-body-sm text-fg-secondary hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast"
          >
            {t('profiles.delete.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              'h-8 px-3 rounded-md text-body-sm font-medium bg-error text-white',
              'transition-opacity duration-fast hover:opacity-90',
            )}
          >
            {t('profiles.delete.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
