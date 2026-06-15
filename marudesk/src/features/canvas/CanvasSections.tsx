import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Trash2 } from 'lucide-react';
import type { TabGroupColor } from '../../../shared/browser';
import { cn } from '../../lib/cn';
import { EDGE_SIDES, SECTION_HEADER_H, useCanvasStore, type CardSection, type EdgeSide } from './store';

/** Where each face's connection port sits, centered just outside the frame. */
const PORT_POS: Record<EdgeSide, string> = {
  top: '-top-2 left-1/2 -translate-x-1/2',
  right: '-right-2 top-1/2 -translate-y-1/2',
  bottom: '-bottom-2 left-1/2 -translate-x-1/2',
  left: '-left-2 top-1/2 -translate-y-1/2',
};

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

export function CanvasSections({
  sections,
  scale,
  onStartConnect,
}: {
  sections: readonly CardSection[];
  scale: number;
  /** Begin dragging a connection from a section's port (sectionId, face, screen px). */
  onStartConnect: (sectionId: string, side: EdgeSide, clientX: number, clientY: number) => void;
}) {
  // Paint larger sections first so a NESTED (smaller) section sits visually on
  // top of its parent and stays interactive.
  const ordered = [...sections].sort((a, b) => b.w * b.h - a.w * a.h);
  return (
    <>
      {ordered.map((sec) => (
        <SectionFrame key={sec.id} section={sec} scale={scale} onStartConnect={onStartConnect} />
      ))}
    </>
  );
}

function SectionFrame({
  section,
  scale,
  onStartConnect,
}: {
  section: CardSection;
  scale: number;
  onStartConnect: (sectionId: string, side: EdgeSide, clientX: number, clientY: number) => void;
}) {
  const cls = SECTION_CLASSES[section.color];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.title);
  // Drag = the section frame + the cards inside it + any NESTED sections (and
  // their cards) move together; resize = frame only.
  const moveRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    cards: { key: string; x: number; y: number }[];
    childSections: { id: string; x: number; y: number }[];
  } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; origW: number; origH: number } | null>(null);

  const onHeaderDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || editing) return;
    e.stopPropagation();
    const store = useCanvasStore.getState();
    const placements = store.placements;
    // Cards whose centre is inside this section move with it.
    const cards = store
      .sectionMemberKeys(section.id)
      .map((key) => ({ key, x: placements[key].x, y: placements[key].y }));
    // Nested sections (centre inside this one) move too — their own cards are
    // already covered above, since they sit inside this section as well.
    const childSections = store.sections
      .filter((sec) => {
        if (sec.id === section.id) return false;
        const scx = sec.x + sec.w / 2;
        const scy = sec.y + sec.h / 2;
        return scx >= section.x && scx <= section.x + section.w && scy >= section.y && scy <= section.y + section.h;
      })
      .map((sec) => ({ id: sec.id, x: sec.x, y: sec.y }));
    e.currentTarget.setPointerCapture(e.pointerId);
    moveRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: section.x,
      origY: section.y,
      cards,
      childSections,
    };
  };
  const onHeaderMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const m = moveRef.current;
    if (!m || m.pointerId !== e.pointerId) return;
    const dx = (e.clientX - m.startX) / scale;
    const dy = (e.clientY - m.startY) / scale;
    const store = useCanvasStore.getState();
    store.setSectionPos(section.id, m.origX + dx, m.origY + dy);
    for (const c of m.cards) store.setPos(c.key, c.x + dx, c.y + dy);
    for (const sec of m.childSections) store.setSectionPos(sec.id, sec.x + dx, sec.y + dy);
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
      data-section-id={section.id}
      className={cn('group/section absolute rounded-lg border-2 border-dashed', cls.frame)}
      style={{ left: section.x, top: section.y, width: section.w, height: section.h, zIndex: 0 }}
    >
      {/* Connection ports — drag onto another section/card to wire them. One per
          face, just outside the frame; fade in on hover. */}
      {EDGE_SIDES.map((side) => (
        <button
          key={side}
          type="button"
          aria-label={`Connect from ${side} edge`}
          title="Drag to another section or card to connect"
          className={cn(
            'absolute z-10 h-3.5 w-3.5 rounded-pill border opacity-0 transition-opacity duration-fast',
            'bg-surface-1 cursor-crosshair group-hover/section:opacity-100',
            cls.frame,
            PORT_POS[side],
          )}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            onStartConnect(section.id, side, e.clientX, e.clientY);
          }}
        />
      ))}
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
