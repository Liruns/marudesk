import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Trash2 } from 'lucide-react';
import type { TabGroupColor } from '../../../shared/browser';
import { cn } from '../../lib/cn';
import { SECTION_HEADER_H, useCanvasStore, type CardSection } from './store';

/**
 * Labeled section frames drawn BEHIND the cards on the canvas plane. A section
 * groups the cards inside it into a named region (FigJam-style): drag its header
 * to move the frame and the cards within it together, double-click the title to
 * rename, resize from the corner, recolor, or delete (cards are untouched).
 *
 * Geometry-only (see {@link CardSection}) — membership is spatial, resolved from
 * the live placements at drag start, so a section never holds tab references.
 */

const SECTION_CLASSES: Record<TabGroupColor, { frame: string; header: string; text: string; dot: string }> = {
  violet: { frame: 'border-tabgroup-violet/40', header: 'bg-tabgroup-violet/15', text: 'text-tabgroup-violet', dot: 'bg-tabgroup-violet' },
  blue: { frame: 'border-tabgroup-blue/40', header: 'bg-tabgroup-blue/15', text: 'text-tabgroup-blue', dot: 'bg-tabgroup-blue' },
  teal: { frame: 'border-tabgroup-teal/40', header: 'bg-tabgroup-teal/15', text: 'text-tabgroup-teal', dot: 'bg-tabgroup-teal' },
  green: { frame: 'border-tabgroup-green/40', header: 'bg-tabgroup-green/15', text: 'text-tabgroup-green', dot: 'bg-tabgroup-green' },
  amber: { frame: 'border-tabgroup-amber/40', header: 'bg-tabgroup-amber/15', text: 'text-tabgroup-amber', dot: 'bg-tabgroup-amber' },
  rose: { frame: 'border-tabgroup-rose/40', header: 'bg-tabgroup-rose/15', text: 'text-tabgroup-rose', dot: 'bg-tabgroup-rose' },
};

const SECTION_COLOR_CYCLE: readonly TabGroupColor[] = ['violet', 'blue', 'teal', 'green', 'amber', 'rose'];

export function CanvasSections({ sections, scale }: { sections: readonly CardSection[]; scale: number }) {
  return (
    <>
      {sections.map((sec) => (
        <SectionFrame key={sec.id} section={sec} scale={scale} />
      ))}
    </>
  );
}

function SectionFrame({ section, scale }: { section: CardSection; scale: number }) {
  const cls = SECTION_CLASSES[section.color];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.title);
  // Drag = the section frame + the cards inside it move together; resize = frame only.
  const moveRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    members: { key: string; x: number; y: number }[];
  } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; origW: number; origH: number } | null>(null);

  const onHeaderDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || editing) return;
    e.stopPropagation();
    const store = useCanvasStore.getState();
    const placements = store.placements;
    const members = store
      .sectionMemberKeys(section.id)
      .map((key) => ({ key, x: placements[key].x, y: placements[key].y }));
    e.currentTarget.setPointerCapture(e.pointerId);
    moveRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origX: section.x, origY: section.y, members };
  };
  const onHeaderMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const m = moveRef.current;
    if (!m || m.pointerId !== e.pointerId) return;
    const dx = (e.clientX - m.startX) / scale;
    const dy = (e.clientY - m.startY) / scale;
    const store = useCanvasStore.getState();
    store.setSectionPos(section.id, m.origX + dx, m.origY + dy);
    for (const mem of m.members) store.setPos(mem.key, mem.x + dx, mem.y + dy);
  };
  const onHeaderUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (moveRef.current?.pointerId === e.pointerId) moveRef.current = null;
  };

  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origW: section.w, origH: section.h };
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    useCanvasStore
      .getState()
      .setSectionSize(section.id, r.origW + (e.clientX - r.startX) / scale, r.origH + (e.clientY - r.startY) / scale);
  };
  const onResizeUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId === e.pointerId) resizeRef.current = null;
  };

  const commitRename = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== section.title) useCanvasStore.getState().renameSection(section.id, next);
    else setDraft(section.title);
  };

  const cycleColor = () => {
    const i = SECTION_COLOR_CYCLE.indexOf(section.color);
    useCanvasStore.getState().setSectionColor(section.id, SECTION_COLOR_CYCLE[(i + 1) % SECTION_COLOR_CYCLE.length]);
  };

  return (
    <div
      data-canvas-section
      className={cn('group/section absolute rounded-lg border-2 border-dashed', cls.frame)}
      style={{ left: section.x, top: section.y, width: section.w, height: section.h, zIndex: 0 }}
    >
      <div
        className={cn(
          'flex h-[30px] items-center gap-1.5 rounded-t-md px-2 cursor-grab active:cursor-grabbing select-none',
          cls.header,
        )}
        style={{ height: SECTION_HEADER_H }}
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        onPointerCancel={onHeaderUp}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(section.title);
          setEditing(true);
        }}
      >
        <button
          type="button"
          aria-label="Change section color"
          title="Change color"
          className={cn('size-2.5 shrink-0 rounded-full', cls.dot)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            cycleColor();
          }}
        />
        {editing ? (
          <input
            autoFocus
            value={draft}
            aria-label="Section title"
            className={cn('min-w-0 flex-1 bg-transparent text-caption font-medium focus:outline-none', cls.text)}
            onChange={(e) => setDraft(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              else if (e.key === 'Escape') {
                setDraft(section.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className={cn('min-w-0 flex-1 truncate text-caption font-medium', cls.text)}>{section.title}</span>
        )}
        <button
          type="button"
          aria-label="Delete section"
          title="Delete section (keeps the cards)"
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded opacity-0 transition-opacity duration-fast',
            'hover:bg-surface-1/60 group-hover/section:opacity-100',
            cls.text,
          )}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            useCanvasStore.getState().removeSection(section.id);
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* Resize grip (SE) — reframes the section without moving cards. */}
      <div
        role="separator"
        aria-label="Resize section"
        className="absolute -bottom-1 -right-1 size-4 cursor-nwse-resize opacity-0 group-hover/section:opacity-100"
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
