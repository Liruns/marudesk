import { useState } from 'react';
import { ChevronDown, ChevronRight, FileDiff, Undo2 } from 'lucide-react';
import type { RemoteEditDiff, RemoteEditStatus } from '../types';
import { DiffText } from './DiffText';

/**
 * One PC-applied file edit in the chat flow (patch review): a collapsed card —
 * file label + +N/−M stats + status — that expands to the scrollable colored
 * diff. Applied edits offer Revert, which the store routes to the PC as the
 * `revert-edit` command (the PC owns the disk; its staleness guard may refuse).
 */

const STATUS_META: Record<RemoteEditStatus, { label: string; color: string }> = {
  applied: { label: 'Applied', color: 'var(--ok)' },
  accepted: { label: 'Kept', color: 'var(--ok)' },
  reverted: { label: 'Reverted', color: 'var(--fg-faint)' },
};

export function EditDiffCard({
  edit,
  busy,
  onRevert,
}: {
  edit: RemoteEditDiff;
  busy: boolean;
  /** Absent when the transport can't carry the revert command. */
  onRevert?: (editId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[edit.status];
  const hasBody = edit.diff.length > 0;
  return (
    <div className="tool-card edit-card">
      <button
        type="button"
        className="tool-card__header"
        onClick={() => hasBody && setOpen((v) => !v)}
      >
        <FileDiff size={16} className="tool-card__icon" />
        <span className="tool-card__name">{edit.label}</span>
        <span className="edit-card__stats">
          <span className="edit-card__add">+{edit.additions}</span>
          <span className="edit-card__remove">−{edit.deletions}</span>
        </span>
        <span className="tool-card__state" style={{ color: meta.color }}>
          {meta.label}
        </span>
        {hasBody &&
          (open ? (
            <ChevronDown size={16} style={{ color: 'var(--fg-faint)' }} />
          ) : (
            <ChevronRight size={16} style={{ color: 'var(--fg-faint)' }} />
          ))}
      </button>
      {open && hasBody && (
        <div className="tool-card__body">
          <DiffText text={edit.diff} />
          {edit.truncated && (
            <div className="faint" style={{ fontSize: 12 }}>
              Diff truncated — see the full change on the desktop.
            </div>
          )}
          {edit.status === 'applied' && onRevert && (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ minHeight: 36, alignSelf: 'flex-start' }}
              disabled={busy}
              onClick={() => onRevert(edit.id)}
            >
              <Undo2 size={15} /> Revert
            </button>
          )}
        </div>
      )}
    </div>
  );
}
