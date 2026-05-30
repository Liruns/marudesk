import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Save, X } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import type { CssProperty, CssStyle } from '../types';

/**
 * The styles inspector for the selected node: inline `element.style`, then the
 * matched CSS rules (most-specific first — CDP returns least→most), then a
 * collapsible computed-properties list.
 *
 * Editable rules (author `origin: 'regular'` sheets + the inline style) let you
 * click a value to edit it; the change applies live via `CSS.setStyleTexts` and,
 * when it maps to a workspace file, surfaces a "Save to source" banner that
 * writes the edit back through the patch system (§9-B). User-agent rules are
 * read-only.
 */

function ValueCell({
  prop,
  editable,
  onCommit,
}: {
  prop: CssProperty;
  editable: boolean;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(prop.value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (editing) {
    const commit = () => {
      setEditing(false);
      if (draft.trim() !== prop.value) onCommit(draft);
    };
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(prop.value);
            setEditing(false);
          }
        }}
        spellCheck={false}
        aria-label={`Edit ${prop.name}`}
        className="bg-surface-page border border-accent rounded-sm px-1 -my-px font-mono text-caption text-fg-primary focus:outline-none min-w-0 w-32"
      />
    );
  }

  return (
    <span
      role={editable ? 'button' : undefined}
      tabIndex={editable ? 0 : undefined}
      onClick={
        editable
          ? () => {
              setDraft(prop.value);
              setEditing(true);
            }
          : undefined
      }
      className={cn(
        'text-fg-secondary',
        editable && 'cursor-text hover:underline decoration-dotted underline-offset-2',
      )}
    >
      {prop.value}
    </span>
  );
}

function PropRow({
  prop,
  index,
  editable,
  onEdit,
}: {
  prop: CssProperty;
  index: number;
  editable: boolean;
  onEdit: (index: number, value: string) => void;
}) {
  return (
    <div
      className={cn(
        'font-mono text-caption leading-snug pl-3',
        prop.disabled && 'line-through opacity-50',
      )}
    >
      <span className="text-accent">{prop.name}</span>
      <span className="text-fg-tertiary">: </span>
      <ValueCell
        prop={prop}
        editable={editable && !prop.disabled}
        onCommit={(value) => onEdit(index, value)}
      />
      <span className="text-fg-tertiary">;</span>
      {prop.important ? <span className="text-warning"> !important</span> : null}
    </div>
  );
}

function RuleBlock({
  selector,
  style,
  editable,
}: {
  selector: string;
  style: CssStyle;
  editable: boolean;
}) {
  const editStyleProperty = useDevtoolsStore((s) => s.editStyleProperty);
  // Index must be into the full cssProperties array (live-edit math keys off it),
  // so filter for display while preserving the original position.
  const rows = style.cssProperties
    .map((prop, index) => ({ prop, index }))
    .filter((r) => r.prop.name);
  if (rows.length === 0) return null;
  return (
    <div className="px-3 py-1.5 border-b border-subtle/60">
      <div className="font-mono text-caption text-fg-primary mb-0.5">
        {selector} <span className="text-fg-tertiary">{'{'}</span>
      </div>
      {rows.map(({ prop, index }) => (
        <PropRow
          key={index}
          prop={prop}
          index={index}
          editable={editable}
          onEdit={(i, value) => void editStyleProperty(style, i, value)}
        />
      ))}
      <div className="font-mono text-caption text-fg-tertiary">{'}'}</div>
    </div>
  );
}

function SourcePatchBanner() {
  const pending = useDevtoolsStore((s) => s.pendingPatch);
  const apply = useDevtoolsStore((s) => s.applySourcePatch);
  const dismiss = useDevtoolsStore((s) => s.dismissSourcePatch);
  if (!pending) return null;
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-accent-subtle/60 border-b border-accent/40 backdrop-blur-sm">
      <span className="text-caption text-fg-secondary min-w-0 truncate">
        Maps to{' '}
        <span className="font-mono text-fg-primary" title={pending.path}>
          {pending.path}:{pending.startLine}
        </span>
      </span>
      <button
        type="button"
        onClick={() => void apply()}
        className="ml-auto shrink-0 flex items-center gap-1 h-6 px-2 rounded bg-accent text-white text-caption hover:bg-accent-hover"
      >
        <Save size={12} />
        Save to source
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 text-fg-tertiary hover:text-fg-primary"
      >
        <X size={14} />
      </button>
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
      <SourcePatchBanner />
      {styles.inline && styles.inline.cssProperties.some((p) => p.name) ? (
        <RuleBlock
          selector="element.style"
          style={styles.inline}
          editable={!!styles.inline.styleSheetId && !!styles.inline.range}
        />
      ) : null}
      {matched.map((m, i) => (
        <RuleBlock
          key={i}
          selector={m.rule.selectorList.text}
          style={m.rule.style}
          editable={
            m.rule.origin === 'regular' &&
            !!m.rule.style.styleSheetId &&
            !!m.rule.style.range
          }
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
