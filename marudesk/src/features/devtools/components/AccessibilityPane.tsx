import { useEffect, useState } from 'react';
import { useDevtoolsStore } from '../store';
import { cdpTry } from '../cdp';
import type { AXNode, AXProperty, BackgroundColorsInfo } from '../types';
import { formatAxValue } from './elements-utils';

/**
 * The Accessibility pane for the selected node:
 * `Accessibility.getPartialAXTree({ nodeId, fetchRelatives: false })` yields the
 * node's computed AX record (role / name / description / properties, or the
 * ignored state + reasons). `CSS.getBackgroundColors` adds the page colors
 * behind the node for eyeballing contrast — the swatches use the PAGE's color
 * values via inline style (data, not UI chrome, so no design-token concern).
 */

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="font-mono text-caption leading-snug px-2 break-words">
      <span className="text-fg-tertiary">{label}: </span>
      <span className="text-fg-secondary">{value}</span>
    </div>
  );
}

function PropertyList({ properties }: { properties: AXProperty[] }) {
  return (
    <>
      {properties.map((p) => (
        <Row key={p.name} label={p.name} value={formatAxValue(p.value) || p.value.type} />
      ))}
    </>
  );
}

function ContrastInfo({ info }: { info: BackgroundColorsInfo }) {
  const colors = info.backgroundColors ?? [];
  if (colors.length === 0 && !info.computedFontSize && !info.computedFontWeight) return null;
  return (
    <div className="pt-1 border-t border-subtle/60 mt-1">
      <div className="text-caption uppercase tracking-wide text-fg-tertiary px-2 py-1">
        Contrast
      </div>
      {colors.map((c) => (
        <div key={c} className="flex items-center gap-1.5 px-2 py-0.5">
          {/* Swatch shows the PAGE's reported background color (data). */}
          <span
            className="size-3 rounded-sm border border-default shrink-0"
            style={{ backgroundColor: c }}
            aria-hidden
          />
          <span className="font-mono text-caption text-fg-secondary">{c}</span>
        </div>
      ))}
      {info.computedFontSize ? <Row label="font-size" value={info.computedFontSize} /> : null}
      {info.computedFontWeight ? (
        <Row label="font-weight" value={info.computedFontWeight} />
      ) : null}
    </div>
  );
}

/** A finished fetch for one selection (either field may be legitimately null). */
type AxResult = { node: AXNode | null; contrast: BackgroundColorsInfo | null };

export function AccessibilityPane() {
  const tabId = useDevtoolsStore((s) => s.tabId);
  const selectedId = useDevtoolsStore((s) => s.selectedId);
  // null = loading. Reset on selection change via the store-previous-prop
  // pattern (render-time, no effect cascade) — matches NetworkPanel's Detail.
  const [result, setResult] = useState<AxResult | null>(null);
  const key = `${tabId ?? ''}:${selectedId ?? 'none'}`;
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setResult(null);
  }

  useEffect(() => {
    let cancelled = false;
    if (!tabId || selectedId === null) return;
    void (async () => {
      const [tree, colors] = await Promise.all([
        cdpTry<{ nodes: AXNode[] }>(tabId, 'Accessibility.getPartialAXTree', {
          nodeId: selectedId,
          fetchRelatives: false,
        }),
        cdpTry<BackgroundColorsInfo>(tabId, 'CSS.getBackgroundColors', {
          nodeId: selectedId,
        }),
      ]);
      if (cancelled) return;
      setResult({ node: tree?.nodes[0] ?? null, contrast: colors ?? null });
    })();
    return () => {
      cancelled = true;
    };
  }, [tabId, selectedId]);

  if (selectedId === null) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        Select an element to inspect its accessibility node
      </div>
    );
  }
  if (result === null) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        Loading accessibility node...
      </div>
    );
  }
  const ax = result.node;
  const contrast = result.contrast;
  if (ax === null) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        No accessibility node
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto py-1">
      {ax.ignored ? (
        <>
          <div className="px-2 py-0.5 text-caption text-warning">
            Ignored by the accessibility tree
          </div>
          {ax.ignoredReasons && ax.ignoredReasons.length > 0 ? (
            <PropertyList properties={ax.ignoredReasons} />
          ) : null}
        </>
      ) : (
        <>
          <Row label="role" value={formatAxValue(ax.role) || '(none)'} />
          <Row label="name" value={formatAxValue(ax.name) || '(empty)'} />
          {formatAxValue(ax.description) ? (
            <Row label="description" value={formatAxValue(ax.description)} />
          ) : null}
          {ax.properties && ax.properties.length > 0 ? (
            <div className="pt-1 border-t border-subtle/60 mt-1">
              <div className="text-caption uppercase tracking-wide text-fg-tertiary px-2 py-1">
                Properties
              </div>
              <PropertyList properties={ax.properties} />
            </div>
          ) : null}
        </>
      )}
      {contrast ? <ContrastInfo info={contrast} /> : null}
    </div>
  );
}
