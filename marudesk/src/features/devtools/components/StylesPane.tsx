import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../i18n/useI18n';
import type { TranslationKey } from '../../../i18n/messages';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import { BoxModel } from './BoxModel';
import { SourcePatchBanner } from './SourcePatchBanner';
import {
  COMPUTED_GROUP_ORDER,
  computedGroup,
  type ComputedGroupId,
} from '../computed-groups';
import type { ComputedStyleProperty, CssProperty, CssStyle } from '../types';

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

const GROUP_LABELS: Record<ComputedGroupId, TranslationKey> = {
  layout: 'devtools.styles.group.layout',
  text: 'devtools.styles.group.text',
  appearance: 'devtools.styles.group.appearance',
  other: 'devtools.styles.group.other',
};

/**
 * The Computed tab: the box-model diagram on top (DOM.getBoxModel), then the
 * full computed-style list (CSS.getComputedStyleForNode, loaded with the
 * selection), filterable and grouped into layout/text/appearance/other.
 */
function ComputedPane({ computed }: { computed: ComputedStyleProperty[] }) {
  const { t } = useI18n();
  const boxModel = useDevtoolsStore((s) => s.boxModel);
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const visible = q
      ? computed.filter((c) => c.name.includes(q) || c.value.toLowerCase().includes(q))
      : computed;
    const byGroup = new Map<ComputedGroupId, ComputedStyleProperty[]>();
    for (const prop of visible) {
      const id = computedGroup(prop.name);
      const arr = byGroup.get(id);
      if (arr) arr.push(prop);
      else byGroup.set(id, [prop]);
    }
    return byGroup;
  }, [computed, filter]);

  const total = [...groups.values()].reduce((n, arr) => n + arr.length, 0);

  return (
    <div className="flex flex-col">
      {boxModel ? (
        <div className="border-b border-subtle/60">
          <div className="text-caption uppercase tracking-wide text-fg-tertiary px-3 pt-2">
            {t('devtools.styles.boxModel')}
          </div>
          <BoxModel model={boxModel} />
        </div>
      ) : null}
      <div className="px-3 py-1.5">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('devtools.styles.filter')}
          aria-label={t('devtools.styles.filterComputed')}
          className="h-6 w-full rounded bg-surface-2 px-2 font-mono text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-accent/50"
        />
      </div>
      {total === 0 ? (
        <div className="text-caption text-fg-tertiary px-3 pb-2">
          {t('devtools.styles.noMatchingProperties')}
        </div>
      ) : (
        COMPUTED_GROUP_ORDER.map((id) => {
          const props = groups.get(id);
          if (!props || props.length === 0) return null;
          return (
            <div key={id} className="px-3 pb-2">
              <div className="text-caption uppercase tracking-wide text-fg-tertiary pb-0.5">
                {t(GROUP_LABELS[id])}{' '}
                <span className="tabular-nums normal-case">({props.length})</span>
              </div>
              {props.map((c) => (
                <div key={c.name} className="font-mono text-caption leading-snug break-all">
                  <span className="text-fg-tertiary">{c.name}</span>
                  <span className="text-fg-tertiary">: </span>
                  <span className="text-fg-secondary">{c.value}</span>
                </div>
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}

export function StylesPane() {
  const { t } = useI18n();
  const styles = useDevtoolsStore((s) => s.styles);
  const loading = useDevtoolsStore((s) => s.stylesLoading);
  const selectedId = useDevtoolsStore((s) => s.selectedId);
  const [tab, setTab] = useState<'styles' | 'computed'>('styles');

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
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 border-b border-subtle">
        {(['styles', 'computed'] as const).map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'h-6 px-2 rounded text-caption transition-colors duration-fast',
              tab === id
                ? 'bg-surface-page text-fg-primary'
                : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
            )}
          >
            {id === 'styles' ? t('devtools.styles.stylesTab') : t('devtools.styles.computed')}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'styles' ? (
          <>
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
          </>
        ) : (
          <ComputedPane computed={styles.computed} />
        )}
      </div>
    </div>
  );
}
