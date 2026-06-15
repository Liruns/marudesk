import type { CardRect, Edge, EdgeSide, EdgeStyle } from './store';
import { anchorOnSide, autoSide, edgeEndpoints, pathFor } from './edgeGeometry';

/**
 * SVG overlay that draws the node connections (edges) between cards, plus the
 * live preview wire while the user is dragging a new connection. Rendered inside
 * the CSS-transformed plane, so paths are in canvas coordinates and pan/zoom with
 * the cards for free. The `<svg>` is pointer-events-none; only the per-edge hit
 * stroke opts back in, so edges never block card/canvas interaction.
 *
 * Each end attaches to a specific face (4-directional ports). An end without an
 * explicit side falls back to the face pointing at the other node, so legacy
 * edges (drawn before sides existed) still render sensibly. Edges render as a
 * flowing bezier or right-angled (orthogonal) route per the canvas-wide
 * `edgeStyle`. The selected edge's delete control is drawn by the stage in a
 * layer ABOVE the cards (so it's clickable when the wire passes over a card).
 */

export type ConnectPreview = { from: string; fromSide?: EdgeSide; x: number; y: number };

export function CanvasEdges({
  placements,
  edges,
  edgeStyle,
  selectedEdgeId,
  preview,
  onSelectEdge,
  keyOf,
}: {
  placements: Record<string, CardRect>;
  edges: readonly Edge[];
  edgeStyle: EdgeStyle;
  selectedEdgeId: string | null;
  preview: ConnectPreview | null;
  onSelectEdge: (id: string) => void;
  /** Resolve an edge's tab id to its placement key (group id when merged). */
  keyOf: (tabId: string) => string;
}) {
  return (
    <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1}>
      {edges.map((e) => {
        const a = placements[keyOf(e.from)];
        const b = placements[keyOf(e.to)];
        if (!a || !b) return null;
        const { p1, p2, fromSide, toSide } = edgeEndpoints(a, b, e);
        const d = pathFor(edgeStyle, p1, fromSide, p2, toSide);
        const selected = e.id === selectedEdgeId;
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
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeWidth={selected ? 2.5 : 1.5}
              style={{ stroke: selected ? 'var(--accent)' : 'var(--border-strong)' }}
            />
          </g>
        );
      })}

      {preview && placements[keyOf(preview.from)]
        ? (() => {
            // The source may be a merged card — resolve through its group key so
            // the live preview wire anchors to the group card, not a missing
            // per-member placement.
            const a = placements[keyOf(preview.from)];
            const loose = { x: preview.x, y: preview.y };
            const fromSide = preview.fromSide ?? autoSide(a, loose);
            const p1 = anchorOnSide(a, fromSide);
            return (
              <path
                d={pathFor(edgeStyle, p1, fromSide, loose, null)}
                fill="none"
                strokeWidth={2}
                strokeDasharray="5 4"
                strokeLinejoin="round"
                strokeLinecap="round"
                style={{ stroke: 'var(--accent)' }}
              />
            );
          })()
        : null}
    </svg>
  );
}
