import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { Trash2 } from 'lucide-react';
import type { TabGroupColor } from '../../../shared/browser';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import { useCanvasStore, type CanvasNote } from './store';

/**
 * Free-floating sticky notes — a lightweight annotation layer on the canvas
 * plane (Miro/FigJam parity). Drag the grip to move, type in the body, recolor
 * via the dot, resize from the corner, delete from the grip. Pure geometry+text
 * (see {@link CanvasNote}); moves/resizes paint straight to the DOM and commit to
 * the store on release, mirroring the section/card drag perf path.
 */

const NOTE_CLASSES: Record<TabGroupColor, { body: string; grip: string; dot: string; text: string }> = {
  violet: { body: 'bg-tabgroup-violet/15 border-tabgroup-violet/40', grip: 'bg-tabgroup-violet/25', dot: 'bg-tabgroup-violet', text: 'text-tabgroup-violet' },
  blue: { body: 'bg-tabgroup-blue/15 border-tabgroup-blue/40', grip: 'bg-tabgroup-blue/25', dot: 'bg-tabgroup-blue', text: 'text-tabgroup-blue' },
  teal: { body: 'bg-tabgroup-teal/15 border-tabgroup-teal/40', grip: 'bg-tabgroup-teal/25', dot: 'bg-tabgroup-teal', text: 'text-tabgroup-teal' },
  green: { body: 'bg-tabgroup-green/15 border-tabgroup-green/40', grip: 'bg-tabgroup-green/25', dot: 'bg-tabgroup-green', text: 'text-tabgroup-green' },
  amber: { body: 'bg-tabgroup-amber/15 border-tabgroup-amber/40', grip: 'bg-tabgroup-amber/25', dot: 'bg-tabgroup-amber', text: 'text-tabgroup-amber' },
  rose: { body: 'bg-tabgroup-rose/15 border-tabgroup-rose/40', grip: 'bg-tabgroup-rose/25', dot: 'bg-tabgroup-rose', text: 'text-tabgroup-rose' },
};

const COLOR_CYCLE: readonly TabGroupColor[] = ['amber', 'violet', 'blue', 'teal', 'green', 'rose'];
const GRIP_H = 22;

export function CanvasNotes({ notes, scale }: { notes: readonly CanvasNote[]; scale: number }) {
  return (
    <>
      {notes.map((n) => (
        <NoteCard key={n.id} note={n} scale={scale} />
      ))}
    </>
  );
}

function NoteCard({ note, scale }: { note: CanvasNote; scale: number }) {
  const { t } = useI18n();
  const cls = NOTE_CLASSES[note.color];
  const rootRef = useRef<HTMLDivElement>(null);
  const moveRef = useRef<{ pointerId: number; startX: number; startY: number; dx: number; dy: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; w: number; h: number } | null>(null);

  // Re-assert the live drag/resize after any incidental re-render (mirrors the
  // section/card paint path) so the note never snaps back to its store rect.
  useLayoutEffect(() => {
    const m = moveRef.current;
    if (m && rootRef.current) {
      rootRef.current.style.left = `${note.x + m.dx}px`;
      rootRef.current.style.top = `${note.y + m.dy}px`;
    }
    const r = resizeRef.current;
    if (r && rootRef.current) {
      rootRef.current.style.width = `${r.w}px`;
      rootRef.current.style.height = `${r.h}px`;
    }
  });

  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    moveRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0 };
  };
  const onGripMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const m = moveRef.current;
    if (!m || m.pointerId !== e.pointerId) return;
    m.dx = (e.clientX - m.startX) / scale;
    m.dy = (e.clientY - m.startY) / scale;
    if (rootRef.current) {
      rootRef.current.style.left = `${note.x + m.dx}px`;
      rootRef.current.style.top = `${note.y + m.dy}px`;
    }
  };
  const onGripUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const m = moveRef.current;
    if (!m || m.pointerId !== e.pointerId) return;
    moveRef.current = null;
    if (m.dx !== 0 || m.dy !== 0) {
      useCanvasStore.getState().setNotePos(note.id, Math.round(note.x + m.dx), Math.round(note.y + m.dy));
    }
  };

  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, w: note.w, h: note.h };
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    r.w = Math.max(120, note.w + (e.clientX - r.startX) / scale);
    r.h = Math.max(80, note.h + (e.clientY - r.startY) / scale);
    if (rootRef.current) {
      rootRef.current.style.width = `${r.w}px`;
      rootRef.current.style.height = `${r.h}px`;
    }
  };
  const onResizeUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    resizeRef.current = null;
    useCanvasStore.getState().setNoteSize(note.id, r.w, r.h);
  };

  const cycleColor = () => {
    const i = COLOR_CYCLE.indexOf(note.color);
    useCanvasStore.getState().setNoteColor(note.id, COLOR_CYCLE[(i + 1) % COLOR_CYCLE.length]);
  };

  return (
    <div
      ref={rootRef}
      data-canvas-note
      data-note-id={note.id}
      className={cn('group/note absolute flex flex-col rounded-md border shadow-card', cls.body)}
      style={{ left: note.x, top: note.y, width: note.w, height: note.h, zIndex: 1 }}
    >
      <div
        className={cn('flex items-center gap-1.5 rounded-t-md px-1.5 cursor-grab active:cursor-grabbing select-none', cls.grip)}
        style={{ height: GRIP_H }}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
      >
        <button
          type="button"
          aria-label={t('canvas.note.changeColor')}
          title={t('canvas.note.changeColor')}
          className={cn('size-2.5 shrink-0 rounded-full', cls.dot)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            cycleColor();
          }}
        />
        <span className="min-w-0 flex-1" aria-hidden />
        <button
          type="button"
          aria-label={t('canvas.note.delete')}
          title={t('canvas.note.delete')}
          className={cn('grid size-5 shrink-0 place-items-center rounded opacity-0 transition-opacity duration-fast hover:bg-surface-1/60 group-hover/note:opacity-100', cls.text)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            useCanvasStore.getState().removeNote(note.id);
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>
      <textarea
        value={note.text}
        placeholder={t('canvas.note.placeholder')}
        aria-label={t('canvas.note.label')}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => useCanvasStore.getState().setNoteText(note.id, e.target.value)}
      />
      <div
        role="separator"
        aria-label={t('canvas.note.resize')}
        className="absolute -bottom-1 -right-1 size-4 cursor-nwse-resize opacity-0 group-hover/note:opacity-100"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      >
        <span className={cn('absolute bottom-1 right-1 size-2 border-b-2 border-r-2', cls.text)} aria-hidden />
      </div>
    </div>
  );
}
