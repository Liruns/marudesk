import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import { BoxModel } from './BoxModel';
import { SourcePatchBanner } from './SourcePatchBanner';
import type { CssProperty, CssStyle } from '../types';

function ValueCell({
  prop,
  editable,
  onCommit,
}: {
  prop: CssProperty;
  editable: boolean;
  onCommit: (value: string) => void;
}) {
  const { t } = useI18n();
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
        aria-label={`${t('devtools.styles.editBefore')}${prop.name}`}
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

export function StylesPane() {
  const { t } = useI18n();
  const styles = useDevtoolsStore((s) => s.styles);
  const loading = useDevtoolsStore((s) => s.stylesLoading);
  const selectedId = useDevtoolsStore((s) => s.selectedId);
  const boxModel = useDevtoolsStore((s) => s.boxModel);
  const [computedOpen, setComputedOpen] = useState(false);
  const [computedFilter, setComputedFilter] = useState('');

  const computedRows = useMemo(() => {
    const all = styles?.computed ?? [];
    const q = computedFilter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((c) => c.name.includes(q) || c.value.toLowerCase().includes(q));
  }, [styles, computedFilter]);

  if (selectedId === null) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        {t('devtools.styles.selectElement')}
      </div>
    );
  }
  if (loading && !styles) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        {t('devtools.styles.loading')}
      </div>
    );
  }
  if (!styles) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        {t('devtools.styles.noStyles')}
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

      {boxModel ? (
        <div className="border-b border-subtle/60">
          <div className="text-caption uppercase tracking-wide text-fg-tertiary px-3 pt-2">
            {t('devtools.styles.boxModel')}
          </div>
          <BoxModel model={boxModel} />
        </div>
      ) : null}

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
          {t('devtools.styles.computed')} ({styles.computed.length})
        </button>
        {computedOpen ? (
          <div className="pl-2">
            <input
              value={computedFilter}
              onChange={(e) => setComputedFilter(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('devtools.styles.filter')}
              aria-label={t('devtools.styles.filterComputed')}
              className="mb-1 h-6 w-full rounded bg-surface-2 px-2 font-mono text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-accent/50"
            />
            {computedRows.length === 0 ? (
              <div className="text-caption text-fg-tertiary px-1">
                {t('devtools.styles.noMatchingProperties')}
              </div>
            ) : (
              computedRows.map((c) => (
                <div key={c.name} className="font-mono text-caption leading-snug">
                  <span className="text-fg-tertiary">{c.name}</span>
                  <span className="text-fg-tertiary">: </span>
                  <span className="text-fg-secondary">{c.value}</span>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
