import { parseWorkGraph, type WorkGraph } from '../../../shared/work-os';
import type { NodePos } from './store';

/**
 * Portable on-disk format for a Task graph — the canvas's Export / Import. It is
 * a superset of what {@link parseWorkGraph} restores: the validated graph plus
 * the node layout, so a re-imported graph looks the same instead of being
 * re-laid-out from scratch. `version` lets a reader reject a future incompatible
 * schema rather than silently mis-parse it.
 *
 * Security: import is untrusted input. The graph always passes through
 * `parseWorkGraph` (drops malformed tasks/edges, rejects empty or cyclic graphs)
 * and positions are sanitized to finite `{x,y}` for kept task ids only, so a
 * hostile or corrupt file can never produce an unsafe in-memory graph. This is a
 * pure module (no IPC, no fs) — the renderer reads the file via the File API.
 */
export const GRAPH_TRANSFER_VERSION = 1;

export interface GraphTransferFile {
  readonly version: number;
  readonly exportedAt: number;
  readonly graph: WorkGraph;
  readonly pos: Record<string, NodePos>;
}

/** Keep only finite `{x,y}` entries for known task ids — never trust raw shape. */
function sanitizePos(pos: unknown, taskIds: ReadonlySet<string>): Record<string, NodePos> {
  const out: Record<string, NodePos> = {};
  if (pos && typeof pos === 'object') {
    for (const [id, value] of Object.entries(pos as Record<string, unknown>)) {
      if (!taskIds.has(id) || !value || typeof value !== 'object') continue;
      const { x, y } = value as { x?: unknown; y?: unknown };
      if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
        out[id] = { x, y };
      }
    }
  }
  return out;
}

/** Serialize a graph + its node layout to a pretty JSON document for download. */
export function serializeGraphTransfer(graph: WorkGraph, pos: Record<string, NodePos>): string {
  const file: GraphTransferFile = {
    version: GRAPH_TRANSFER_VERSION,
    exportedAt: Date.now(),
    graph,
    pos: sanitizePos(pos, new Set(graph.tasks.map((tk) => tk.id))),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Parse an untrusted import file into a validated graph + layout, or null when it
 * is unusable. Accepts either the wrapped transfer file (`{ version, graph, pos }`)
 * or a bare graph object, so a hand-written or older blob still imports. The graph
 * is validated by {@link parseWorkGraph}; positions are sanitized.
 */
export function parseGraphTransfer(text: string): { graph: WorkGraph; pos: Record<string, NodePos> } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  // A wrapped file nests the graph under `graph`; a bare export IS the graph.
  const graph = parseWorkGraph('graph' in rec ? rec.graph : rec);
  if (!graph) return null;
  return { graph, pos: sanitizePos(rec.pos, new Set(graph.tasks.map((tk) => tk.id))) };
}
