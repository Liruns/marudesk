import type { MouseEvent as ReactMouseEvent } from 'react';
import type { CardRect, Viewport } from './store';

/**
 * A small overview of the whole canvas (cate parity — its `Cmd+Shift+M` map):
 * every card as a tiny rect plus the current viewport as an outlined box.
 * Clicking recenters the viewport on that point. Sizes/positions are in canvas
 * coordinates, scaled to fit the minimap box.
 */
const MM_W = 190;
const MM_H = 120;
const PAD = 8;

export function CanvasMinimap({
  placements,
  viewport,
  width,
  height,
  onJump,
}: {
  placements: Record<string, CardRect>;
  viewport: Viewport;
  /** Container size in screen px (for the viewport-rect overlay). */
  width: number;
  height: number;
  onJump: (worldX: number, worldY: number) => void;
}) {
  const entries = Object.entries(placements);
  if (entries.length === 0 || width === 0 || height === 0) return null;

  const rects = entries.map(([, r]) => r);
  const visW = width / viewport.scale;
  const visH = height / viewport.scale;
  const viewX = -viewport.panX / viewport.scale;
  const viewY = -viewport.panY / viewport.scale;

  const minX = Math.min(viewX, ...rects.map((r) => r.x));
  const minY = Math.min(viewY, ...rects.map((r) => r.y));
  const maxX = Math.max(viewX + visW, ...rects.map((r) => r.x + r.w));
  const maxY = Math.max(viewY + visH, ...rects.map((r) => r.y + r.h));
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);

  const s = Math.min((MM_W - PAD * 2) / bw, (MM_H - PAD * 2) / bh);
  const ox = (MM_W - bw * s) / 2;
  const oy = (MM_H - bh * s) / 2;
  const tx = (wx: number) => ox + (wx - minX) * s;
  const ty = (wy: number) => oy + (wy - minY) * s;

  const onClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onJump(minX + (e.clientX - r.left - ox) / s, minY + (e.clientY - r.top - oy) / s);
  };

  return (
    <div className="absolute bottom-4 left-3 z-40 rounded-lg chrome-panel p-1 shadow-card" aria-label="Canvas minimap">
      <svg width={MM_W} height={MM_H} className="block cursor-pointer rounded" onClick={onClick}>
        <rect x={0} y={0} width={MM_W} height={MM_H} rx={4} fill="var(--surface-page)" />
        {entries.map(([id, r]) => (
          <rect
            key={id}
            x={tx(r.x)}
            y={ty(r.y)}
            width={Math.max(2, r.w * s)}
            height={Math.max(2, r.h * s)}
            rx={1.5}
            fill="var(--surface-3)"
            stroke="var(--border-strong)"
            strokeWidth={0.5}
          />
        ))}
        <rect
          x={tx(viewX)}
          y={ty(viewY)}
          width={visW * s}
          height={visH * s}
          rx={2}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.5}
        />
      </svg>
    </div>
  );
}
