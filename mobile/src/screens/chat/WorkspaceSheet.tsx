import { Check, Globe, Monitor } from 'lucide-react';
import { BottomSheet } from '../../components/BottomSheet';
import { useAppStore } from '../../store/useAppStore';

/**
 * Pick which PC workspace this phone's chat lives in. The list is the PC's open
 * workspaces (`GET /agent/workspaces`); "No workspace" is the global chat used
 * when nothing is open on the desktop. Switching re-keys the event stream, so
 * the chat repaints with that workspace's active conversation — the same one
 * the desktop UI shows for it. A "PC" badge marks the workspace the desktop is
 * looking at right now.
 */
export function WorkspaceSheet({ onClose }: { readonly onClose: () => void }) {
  const workspaces = useAppStore((s) => s.workspaces);
  const pcActiveWorkspaceId = useAppStore((s) => s.pcActiveWorkspaceId);
  const workspaceId = useAppStore((s) => s.workspaceId);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);

  const pick = (id: string | null) => {
    void selectWorkspace(id);
    onClose();
  };

  return (
    <BottomSheet title="Workspace" onClose={onClose}>
      <button
        type="button"
        className={`picker-row${workspaceId === null ? ' picker-row--active' : ''}`}
        onClick={() => pick(null)}
      >
        <Globe size={16} className="picker-row__icon" />
        <span className="picker-row__label">No workspace</span>
        {workspaceId === null && <Check size={16} className="picker-row__check" />}
      </button>
      {workspaces.map((ws) => {
        const active = workspaceId === ws.id;
        return (
          <button
            key={ws.id}
            type="button"
            className={`picker-row${active ? ' picker-row--active' : ''}`}
            onClick={() => pick(ws.id)}
          >
            <Monitor size={16} className="picker-row__icon" />
            <span className="picker-row__label">{ws.name}</span>
            {ws.id === pcActiveWorkspaceId && <span className="picker-row__badge">PC</span>}
            {active && <Check size={16} className="picker-row__check" />}
          </button>
        );
      })}
      {workspaces.length === 0 && (
        <div className="picker-empty">No workspaces are open on the PC.</div>
      )}
    </BottomSheet>
  );
}
