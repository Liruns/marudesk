import type { CardRect, Edge } from './store';

/**
 * SVG overlay that draws the node connections (edges) between cards, plus the
 * live preview wire while the user is dragging a new connection. Rendered inside
 * the CSS-transformed plane, so paths are in canvas coordinates and pan/zoom with
 * the cards for free. The `<svg>` is pointer-events-none; only the per-edge hit
 * stroke and the delete button opt back in, so edges never block card/canvas
 * interaction.
 */

export type ConnectPreview = { from: string; x: number; y: number };

function center(r: CardRect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** The point on `r`'s boundary along the ray from its center toward (tx,ty). */
function anchorOnRect(r: CardRect, tx: number, ty: number): { x: number; y: number } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? r.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? r.h / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

/** A cubic bezier with horizontal control handles (node-editor "flow" look). */
function curve(ax: number, ay: number, bx: number, by: number): string {
  const dx = Math.max(40, Math.abs(bx - ax) / 2);
  return `M ${ax} ${ay} C ${ax + dx} ${ay}, ${bx - dx} ${by}, ${bx} ${by}`;
}

export function CanvasEdges({
  placements,
  edges,
  selectedEdgeId,
  preview,
  onSelectEdge,
  onRemoveEdge,
}: {
  placements: Record<string, CardRect>;
  edges: readonly Edge[];
  selectedEdgeId: string | null;
  preview: ConnectPreview | null;
  onSelectEdge: (id: string) => void;
  onRemoveEdge: (id: string) => void;
}) {
  return (
    <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1}>
      {edges.map((e) => {
        const a = placements[e.from];
        const b = placements[e.to];
        if (!a || !b) return null;
        const ac = center(a);
        const bc = center(b);
        const p1 = anchorOnRect(a, bc.x, bc.y);
        const p2 = anchorOnRect(b, ac.x, ac.y);
        const d = curve(p1.x, p1.y, p2.x, p2.y);
        const selected = e.id === selectedEdgeId;
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        return (
          <g key={e.id} data-edge-id={e.id}>
            {/* Wide invisible stroke = easy click target for selection. */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={14}
              className="pointer-events-auto cursor-pointer"
              onPointerDown={(ev) => {
                ev.stopPropagation();
                onSelectEdge(e.id);
              }}
            />
            <path
              d={d}
              fill="none"
              strokeWidth={selected ? 2.5 : 1.5}
              style={{ stroke: selected ? 'var(--accent)' : 'var(--border-strong)' }}
            />
            {selected ? (
              <foreignObject x={mx - 11} y={my - 11} width={22} height={22} className="overflow-visible">
                <button
                  type="button"
                  aria-label="Remove connection"
                  title="Remove connection"
                  className="pointer-events-auto grid h-[22px] w-[22px] place-items-center rounded-pill border bg-surface-2 text-caption text-fg-secondary hover:text-fg-primary"
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onRemoveEdge(e.id);
                  }}
                >
                  <span aria-hidden>×</span>
                </button>
              </foreignObject>
            ) : null}
          </g>
        );
      })}

      {preview && placements[preview.from]
        ? (() => {
            const a = placements[preview.from];
            const p1 = anchorOnRect(a, preview.x, preview.y);
            return (
              <path
                d={curve(p1.x, p1.y, preview.x, preview.y)}
                fill="none"
                strokeWidth={2}
                strokeDasharray="5 4"
                style={{ stroke: 'var(--accent)' }}
              />
            );
          })()
        : null}
    </svg>
  );
}
