import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import type { CssProperty, CssStyle } from '../types';

/**
 * The styles inspector for the selected node: inline `element.style`, then the
 * matched CSS rules (most-specific first — CDP returns least→most), then a
 * collapsible computed-properties list. Read-only in this milestone (live edit
 * is a later phase).
 */

function PropRow({ prop }: { prop: CssProperty }) {
  return (
    <div
      className={cn(
        'font-mono text-caption leading-snug pl-3',
        prop.disabled && 'line-through opacity-50',
      )}
    >
      <span className="text-accent">{prop.name}</span>
      <span className="text-fg-tertiary">: </span>
      <span className="text-fg-secondary">{prop.value}</span>
      <span className="text-fg-tertiary">;</span>
      {prop.important ? <span className="text-warning"> !important</span> : null}
    </div>
  );
}

function RuleBlock({ selector, style }: { selector: string; style: CssStyle }) {
  const props = style.cssProperties.filter((p) => p.name);
  if (props.length === 0) return null;
  return (
    <div className="px-3 py-1.5 border-b border-subtle/60">
      <div className="font-mono text-caption text-fg-primary mb-0.5">
        {selector} <span className="text-fg-tertiary">{'{'}</span>
      </div>
      {props.map((p, i) => (
        <PropRow key={`${p.name}-${i}`} prop={p} />
      ))}
      <div className="font-mono text-caption text-fg-tertiary">{'}'}</div>
    </div>
  );
}

export function StylesPane() {
  const styles = useDevtoolsStore((s) => s.styles);
  const loading = useDevtoolsStore((s) => s.stylesLoading);
  const selectedId = useDevtoolsStore((s) => s.selectedId);
  const [computedOpen, setComputedOpen] = useState(false);

  if (selectedId === null) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        Select an element to inspect its styles
      </div>
    );
  }
  if (loading && !styles) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        Loading styles…
      </div>
    );
  }
  if (!styles) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        No styles
      </div>
    );
  }

  // CDP returns matched rules least→most specific; show most specific first.
  const matched = [...styles.matched].reverse();

  return (
    <div className="h-full overflow-auto">
      {styles.inline && styles.inline.cssProperties.some((p) => p.name) ? (
        <RuleBlock selector="element.style" style={styles.inline} />
      ) : null}
      {matched.map((m, i) => (
        <RuleBlock
          key={i}
          selector={m.rule.selectorList.text}
          style={m.rule.style}
        />
      ))}

      <div className="px-1 py-1">
        <button
          type="button"
          onClick={() => setComputedOpen((o) => !o)}
          className="flex items-center gap-1 px-2 h-6 text-caption text-fg-secondary hover:text-fg-primary w-full"
        >
          <ChevronRight
            size={12}
            className={cn('transition-transform', computedOpen && 'rotate-90')}
          />
          Computed ({styles.computed.length})
        </button>
        {computedOpen ? (
          <div className="pl-2">
            {styles.computed.map((c) => (
              <div key={c.name} className="font-mono text-caption leading-snug">
                <span className="text-fg-tertiary">{c.name}</span>
                <span className="text-fg-tertiary">: </span>
                <span className="text-fg-secondary">{c.value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
