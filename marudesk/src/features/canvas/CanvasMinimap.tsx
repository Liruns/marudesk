import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useI18n } from '../../i18n/useI18n';
import type { TabGroupColor } from '../../../shared/browser';
import type { CanvasNote, CardRect, CardSection, Viewport } from './store';

/** Per-hue minimap fill for notes (static strings so Tailwind keeps them). */
const NOTE_FILL: Record<TabGroupColor, string> = {
  violet: 'fill-tabgroup-violet/60',
  blue: 'fill-tabgroup-blue/60',
  teal: 'fill-tabgroup-teal/60',
  green: 'fill-tabgroup-green/60',
  amber: 'fill-tabgroup-amber/60',
  rose: 'fill-tabgroup-rose/60',
};

/**
 * A small overview of the whole canvas (cate parity — its `Cmd+Shift+M` map):
 * every card as a tiny rect plus the current viewport as an outlined box.
 * Click to recenter; drag to pan continuously. Sizes/positions are in canvas
 * coordinates, scaled to fit the minimap box.
 */
const MM_W = 190;
const MM_H = 120;
const PAD = 8;

/** The fit transform: canvas coords → minimap px (origin offset + scale). */
type Fit = { minX: number; minY: number; s: number; ox: number; oy: number };

export function CanvasMinimap({
  placements,
  sections,
  notes,
  viewport,
  width,
  height,
  onJump,
}: {
  placements: Record<string, CardRect>;
  /** Section frames, drawn behind the cards (matches the canvas stacking). */
  sections: readonly CardSection[];
  /** Sticky notes, shown as small amber-ish marks in the overview. */
  notes: readonly CanvasNote[];
  viewport: Viewport;
  /** Container size in screen px (for the viewport-rect overlay). */
  width: number;
  height: number;
  onJump: (worldX: number, worldY: number) => void;
}) {
  const { t } = useI18n();
  // While dragging we FREEZE the fit (captured at press) and the svg's screen
  // rect, then map the cursor to a world point with that frozen transform. The
  // fit normally folds in the viewport rect, so panning would otherwise shift the
  // fit every frame and the viewport box would slide out from under the cursor;
  // freezing keeps the box locked to the cursor for the whole drag.
  const dragRef = useRef<(Fit & { rectLeft: number; rectTop: number }) | null>(null);
  const [frozen, setFrozen] = useState<Fit | null>(null);

  const entries = Object.entries(placements);
  if (entries.length === 0 || width === 0 || height === 0) return null;

  const rects = entries.map(([, r]) => r);
  const visW = width / viewport.scale;
  const visH = height / viewport.scale;
  const viewX = -viewport.panX / viewport.scale;
  const viewY = -viewport.panY / viewport.scale;

  // Fit to the UNION of content bounds (cards + sections) and the current viewport
  // rect so the "where am I" box is on-map at every zoom (content-only fit clipped
  // it away at default zoom over a small layout).
  const bounds = [...rects, ...sections, ...notes];
  const minX = Math.min(...bounds.map((r) => r.x), viewX);
  const minY = Math.min(...bounds.map((r) => r.y), viewY);
  const maxX = Math.max(...bounds.map((r) => r.x + r.w), viewX + visW);
  const maxY = Math.max(...bounds.map((r) => r.y + r.h), viewY + visH);
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const s0 = Math.min((MM_W - PAD * 2) / bw, (MM_H - PAD * 2) / bh);
  const live: Fit = { minX, minY, s: s0, ox: (MM_W - bw * s0) / 2, oy: (MM_H - bh * s0) / 2 };

  // Render with the frozen fit during a drag, the live fit otherwise.
  const tf = frozen ?? live;
  const tx = (wx: number) => tf.ox + (wx - tf.minX) * tf.s;
  const ty = (wy: number) => tf.oy + (wy - tf.minY) * tf.s;

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const f = { ...live, rectLeft: r.left, rectTop: r.top };
    dragRef.current = f;
    setFrozen(live);
    e.currentTarget.setPointerCapture(e.pointerId);
    onJump(f.minX + (e.clientX - f.rectLeft - f.ox) / f.s, f.minY + (e.clientY - f.rectTop - f.oy) / f.s);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const f = dragRef.current;
    if (!f) return;
    onJump(f.minX + (e.clientX - f.rectLeft - f.ox) / f.s, f.minY + (e.clientY - f.rectTop - f.oy) / f.s);
  };
  const endDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setFrozen(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div
      className="absolute bottom-4 left-3 z-40 rounded-lg chrome-panel p-1 shadow-card"
      aria-label={t('canvas.minimap')}
      // Don't let a minimap press bubble to the canvas (which would start a pan
      // and clear focus/selection); the svg's own pointer handlers drive it.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <svg
        width={MM_W}
        height={MM_H}
        className="block cursor-pointer rounded touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <rect x={0} y={0} width={MM_W} height={MM_H} rx={4} fill="var(--surface-page)" />
        {/* Section frames behind the cards (dashed, like on the canvas). */}
        {sections.map((sec) => (
          <rect
            key={sec.id}
            x={tx(sec.x)}
            y={ty(sec.y)}
            width={Math.max(2, sec.w * tf.s)}
            height={Math.max(2, sec.h * tf.s)}
            rx={2}
            fill="var(--accent)"
            fillOpacity={0.05}
            stroke="var(--accent)"
            strokeOpacity={0.5}
            strokeWidth={0.5}
            strokeDasharray="2 2"
          />
        ))}
        {/* Sticky notes — small filled marks (behind cards, above sections). */}
        {notes.map((n) => (
          <rect
            key={n.id}
            x={tx(n.x)}
            y={ty(n.y)}
            width={Math.max(2, n.w * tf.s)}
            height={Math.max(2, n.h * tf.s)}
            rx={1}
            className={NOTE_FILL[n.color]}
          />
        ))}
        {entries.map(([id, r]) => (
          <rect
            key={id}
            x={tx(r.x)}
            y={ty(r.y)}
            width={Math.max(2, r.w * tf.s)}
            height={Math.max(2, r.h * tf.s)}
            rx={1.5}
            fill="var(--surface-3)"
            stroke="var(--border-strong)"
            strokeWidth={0.5}
          />
        ))}
        <rect
          x={tx(viewX)}
          y={ty(viewY)}
          width={Math.max(3, visW * tf.s)}
          height={Math.max(3, visH * tf.s)}
          rx={2}
          fill="var(--accent)"
          fillOpacity={0.08}
          stroke="var(--accent)"
          strokeWidth={1.5}
        />
      </svg>
    </div>
  );
}
