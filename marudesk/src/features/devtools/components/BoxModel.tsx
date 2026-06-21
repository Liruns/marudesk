import type { BoxModel as BoxModelData } from '../types';

/**
 * The CSS box-model diagram for the selected node (DOM.getBoxModel): nested
 * margin ⊃ border ⊃ padding ⊃ content boxes with each edge's px size. Sizes are
 * derived from the difference between consecutive quads' top-left corners (and
 * widths), which is robust for the common axis-aligned case.
 */

/** A quad is `[x1,y1, x2,y2, x3,y3, x4,y4]`; return its width/height/left/top. */
function quadBox(q: number[]): { w: number; h: number; left: number; top: number } {
  if (q.length < 8) return { w: 0, h: 0, left: 0, top: 0 };
  return { left: q[0], top: q[1], w: q[2] - q[0], h: q[5] - q[1] };
}

/** Edge thicknesses between an outer and inner quad (top/right/bottom/left). */
function edges(outer: number[], inner: number[]) {
  const o = quadBox(outer);
  const i = quadBox(inner);
  return {
    top: Math.round(i.top - o.top),
    left: Math.round(i.left - o.left),
    right: Math.round(o.left + o.w - (i.left + i.w)),
    bottom: Math.round(o.top + o.h - (i.top + i.h)),
  };
}

function EdgeLabel({ value }: { value: number }) {
  return <span className="tabular-nums">{value || '-'}</span>;
}

/** One labelled ring (margin / border / padding) wrapping its children. */
function Ring({
  label,
  fillClass,
  e,
  children,
}: {
  label: string;
  /** A `bg-boxmodel-*` token alias — never a literal color (DESIGN.md). */
  fillClass: string;
  e: { top: number; right: number; bottom: number; left: number };
  children: React.ReactNode;
}) {
  return (
    <div className={`relative inline-block p-4 ${fillClass}`}>
      <span className="absolute top-0 left-1 text-[9px] uppercase tracking-wide text-fg-tertiary">
        {label}
      </span>
      <div className="absolute top-0 left-1/2 -translate-x-1/2 text-[10px] text-fg-secondary">
        <EdgeLabel value={e.top} />
      </div>
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 text-[10px] text-fg-secondary">
        <EdgeLabel value={e.bottom} />
      </div>
      <div className="absolute left-0.5 top-1/2 -translate-y-1/2 text-[10px] text-fg-secondary">
        <EdgeLabel value={e.left} />
      </div>
      <div className="absolute right-0.5 top-1/2 -translate-y-1/2 text-[10px] text-fg-secondary">
        <EdgeLabel value={e.right} />
      </div>
      {children}
    </div>
  );
}

export function BoxModel({ model }: { model: BoxModelData }) {
  const margin = edges(model.margin, model.border);
  const border = edges(model.border, model.padding);
  const padding = edges(model.padding, model.content);
  return (
    <div className="flex justify-center py-2 font-mono text-caption">
      <Ring label="margin" fillClass="bg-boxmodel-margin" e={margin}>
        <Ring label="border" fillClass="bg-boxmodel-border" e={border}>
          <Ring label="padding" fillClass="bg-boxmodel-padding" e={padding}>
            <div className="px-3 py-2 text-center bg-boxmodel-content text-fg-primary tabular-nums">
              {Math.round(model.width)} × {Math.round(model.height)}
            </div>
          </Ring>
        </Ring>
      </Ring>
    </div>
  );
}
