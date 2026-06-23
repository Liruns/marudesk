import { useI18n } from '../../../i18n/useI18n';
import type { TranslationKey } from '../../../i18n/messages';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToDot,
  ArrowUpFromDot,
  ChevronRight,
  Pause,
  Play,
  Plus,
  Redo2,
  X,
} from 'lucide-react';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import { RemoteValue } from '../components/RemoteValue';
import { groupScriptsByOrigin, pausedReasonLabel, scriptLabel } from '../sources-utils';
import { originalPositionFor, type ScriptSourceMap } from '../source-map';
import { tokenizeLines, type SyntaxTokenKind } from '../syntax';
import type {
  DebuggerCallFrame,
  DebuggerScope,
  PauseOnExceptions,
  RemoteObject,
} from '../types';

/**
 * Sources panel: a Debugger-domain script browser + breakpoint debugger. The
 * sidebar lists scripts grouped by origin (fed by `Debugger.scriptParsed`) with
 * each script's mapped original sources nested beneath it, plus watch
 * expressions and XHR/event-listener breakpoints (DOMDebugger). The viewer
 * shows a read-only source — original (source-mapped) or compiled — with a
 * breakpoint gutter, and the pause machine (`Debugger.paused`/`resumed`,
 * slice-sources) drives the banner, call stack, and scope panes. Everything
 * here speaks only Debugger/Runtime (+ arm-style DOMDebugger), so the panel
 * stays fully responsive while the page is paused.
 */

// Hard caps so a minified bundle can't melt the renderer: rows beyond the line
// cap are dropped (with a notice), and a single line is clipped to a width that
// still reads (content-visibility handles the vertical volume).
const MAX_VIEW_LINES = 10_000;
const MAX_LINE_CHARS = 4_000;
// The global scope can carry thousands of properties — preview the first slice.
const MAX_SCOPE_PROPS = 200;
// A bundle's source map can list thousands of original files — cap the tree.
const MAX_TREE_SOURCES = 200;

const PAUSE_ON_EXCEPTIONS: { id: PauseOnExceptions; labelKey: TranslationKey }[] = [
  { id: 'none', labelKey: 'devtools.sources.pauseNone' },
  { id: 'uncaught', labelKey: 'devtools.sources.pauseUncaught' },
  { id: 'all', labelKey: 'devtools.sources.pauseAll' },
];

const SCOPE_LABELS: Record<string, TranslationKey> = {
  global: 'devtools.sources.scope.global',
  local: 'devtools.sources.scope.local',
  closure: 'devtools.sources.scope.closure',
  block: 'devtools.sources.scope.block',
  script: 'devtools.sources.scope.script',
  module: 'devtools.sources.scope.module',
  with: 'devtools.sources.scope.with',
  catch: 'devtools.sources.scope.catch',
  'wasm-expression-stack': 'devtools.sources.scope.stack',
};

/** Curated common DOM events for the Event listener breakpoints section. */
const EVENT_BREAKPOINT_NAMES = [
  'click',
  'dblclick',
  'mousedown',
  'mouseup',
  'keydown',
  'keyup',
  'input',
  'change',
  'submit',
  'focus',
  'blur',
  'scroll',
  'load',
  'error',
  'pointerdown',
  'pointerup',
];

function frameTitle(frame: DebuggerCallFrame): string {
  return frame.functionName || '(anonymous)';
}

/**
 * A frame's display location: the mapped original url:line when the frame's
 * script has a resolved source map, the generated one otherwise.
 */
function frameLocation(
  frame: DebuggerCallFrame,
  sourceMaps: ReadonlyMap<string, ScriptSourceMap | null>,
): string {
  const rec = sourceMaps.get(frame.location.scriptId);
  if (rec) {
    const pos = originalPositionFor(
      rec.map,
      frame.location.lineNumber,
      frame.location.columnNumber ?? 0,
    );
    const srcUrl = pos ? rec.sourceUrls[pos.srcIndex] : undefined;
    if (pos && srcUrl) return `${scriptLabel(srcUrl)}:${pos.line + 1}`;
  }
  const file = frame.url ? scriptLabel(frame.url) : '(unknown)';
  return `${file}:${frame.location.lineNumber + 1}`;
}

/** Section header shared by the sidebar panes. */
function PaneHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="shrink-0 px-2 py-1 text-caption font-medium text-fg-tertiary bg-surface-2/40 border-y border-subtle/40 flex items-center gap-1.5">
      {label}
      {count !== undefined ? (
        <span className="tabular-nums text-[10px]">{count}</span>
      ) : null}
    </div>
  );
}

/** Collapsible variant of {@link PaneHeader} for the on-demand sections. */
function CollapsiblePaneHeader({
  label,
  count,
  open,
  onToggle,
}: {
  label: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full shrink-0 px-2 py-1 text-caption font-medium text-fg-tertiary bg-surface-2/40 border-y border-subtle/40 flex items-center gap-1.5 hover:text-fg-secondary"
    >
      <ChevronRight
        size={12}
        className={cn('shrink-0 transition-transform', open && 'rotate-90')}
      />
      {label}
      {count !== undefined && count > 0 ? (
        <span className="tabular-nums text-[10px]">{count}</span>
      ) : null}
    </button>
  );
}

/* ── call stack ───────────────────────────────────────────────────────── */

function CallStackPane() {
  const { t } = useI18n();
  const paused = useDevtoolsStore((s) => s.paused);
  const sourceMaps = useDevtoolsStore((s) => s.sourceMaps);
  if (!paused) return null;
  return (
    <div>
      <PaneHeader label={t('devtools.sources.pane.callStack')} count={paused.callFrames.length} />
      {paused.callFrames.map((frame, i) => (
        <button
          key={frame.callFrameId}
          type="button"
          onClick={() => useDevtoolsStore.getState().selectCallFrame(i)}
          className={cn(
            'w-full text-left px-2 py-0.5 flex items-baseline gap-2 text-caption',
            i === paused.frameIndex
              ? 'bg-accent-subtle/50 text-fg-primary'
              : 'text-fg-secondary hover:bg-surface-2',
          )}
        >
          <span className="font-mono truncate">{frameTitle(frame)}</span>
          <span className="ml-auto shrink-0 font-mono text-fg-tertiary tabular-nums">
            {frameLocation(frame, sourceMaps)}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ── scope chain ──────────────────────────────────────────────────────── */

function ScopeSection({ scope, defaultOpen }: { scope: DebuggerScope; defaultOpen: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const [props, setProps] = useState<{ name: string; value: RemoteObject }[] | null>(null);
  const objectId = scope.object.objectId;

  // Shallow one-level read of the scope's variables (Runtime.getProperties —
  // valid while paused). Fetched when the section is (or starts) open.
  useEffect(() => {
    if (!open || props !== null || !objectId) return;
    let stale = false;
    void useDevtoolsStore
      .getState()
      .getProperties(objectId)
      .then((p) => {
        if (!stale) setProps(p);
      });
    return () => {
      stale = true;
    };
  }, [open, props, objectId]);

  const labelKey = SCOPE_LABELS[scope.type];
  const label = labelKey ? t(labelKey) : scope.type;
  return (
    <div className="border-b border-subtle/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1 px-2 py-0.5 text-caption text-fg-secondary hover:bg-surface-2"
      >
        <ChevronRight
          size={12}
          className={cn('shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className="font-medium">{label}</span>
        {scope.name ? <span className="text-fg-tertiary font-mono truncate">{scope.name}</span> : null}
      </button>
      {open ? (
        <div className="pl-5 pr-2 pb-1 flex flex-col gap-0.5">
          {props === null ? (
            <span className="text-caption text-fg-tertiary">Loading…</span>
          ) : props.length === 0 ? (
            <span className="text-caption text-fg-tertiary">{t('devtools.sources.noVariables')}</span>
          ) : (
            <>
              {props.slice(0, MAX_SCOPE_PROPS).map((p) => (
                <span key={p.name} className="flex items-start gap-1 font-mono text-caption min-w-0">
                  <span className="text-fg-tertiary shrink-0">{p.name}:</span>
                  <RemoteValue obj={p.value} expandable />
                </span>
              ))}
              {props.length > MAX_SCOPE_PROPS ? (
                <span className="text-caption text-fg-tertiary tabular-nums">
                  Showing the first {MAX_SCOPE_PROPS} of {props.length} variables.
                </span>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ScopePane() {
  const { t } = useI18n();
  const paused = useDevtoolsStore((s) => s.paused);
  const frame = paused?.callFrames[paused.frameIndex];
  if (!paused || !frame) return null;
  return (
    <div>
      <PaneHeader label={t('devtools.sources.pane.scope')} />
      {frame.scopeChain.map((scope, i) => (
        // Key on the frame so switching frames remounts (and refetches) scopes.
        <ScopeSection
          key={`${frame.callFrameId}:${i}`}
          scope={scope}
          defaultOpen={scope.type === 'local'}
        />
      ))}
    </div>
  );
}

/* ── watch expressions ────────────────────────────────────────────────── */

function WatchPane() {
  const { t } = useI18n();
  const watches = useDevtoolsStore((s) => s.watchExpressions);
  const results = useDevtoolsStore((s) => s.watchResults);
  const [draft, setDraft] = useState('');

  const submit = () => {
    const expr = draft.trim();
    if (!expr) return;
    useDevtoolsStore.getState().addWatch(expr);
    setDraft('');
  };

  return (
    <div>
      <PaneHeader label={t('devtools.sources.pane.watch')} count={watches.length || undefined} />
      <div className="px-1.5 py-1 flex items-center gap-1 border-b border-subtle/40">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('devtools.sources.addWatch')}
          aria-label={t('devtools.sources.addWatch')}
          className="h-6 flex-1 min-w-0 rounded bg-surface-2 px-2 font-mono text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-accent/50"
        />
        <button
          type="button"
          aria-label={t('devtools.sources.addWatch')}
          title={t('devtools.sources.addWatch')}
          onClick={submit}
          className="size-5 shrink-0 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
        >
          <Plus size={12} />
        </button>
      </div>
      {watches.map((expr) => {
        const res = results.get(expr);
        return (
          <div
            key={expr}
            className="group flex items-start gap-1 px-2 py-0.5 hover:bg-surface-2"
          >
            <span className="flex-1 min-w-0 flex items-start gap-1 font-mono text-caption">
              <span className="text-fg-secondary shrink-0 max-w-[50%] truncate" title={expr}>
                {expr}:
              </span>
              {res === undefined ? (
                <span className="text-fg-tertiary">…</span>
              ) : res.error !== undefined ? (
                <span className="text-fg-tertiary truncate" title={res.error}>
                  {res.error}
                </span>
              ) : res.value ? (
                <RemoteValue obj={res.value} expandable />
              ) : (
                <span className="text-fg-tertiary">undefined</span>
              )}
            </span>
            <button
              type="button"
              aria-label={`Remove watch ${expr}`}
              title={t('devtools.sources.removeWatch')}
              onClick={() => useDevtoolsStore.getState().removeWatch(expr)}
              className="size-4 shrink-0 rounded items-center justify-center text-fg-tertiary hover:text-error hidden group-hover:flex"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ── breakpoints ──────────────────────────────────────────────────────── */

function BreakpointsPane() {
  const { t } = useI18n();
  const breakpoints = useDevtoolsStore((s) => s.breakpoints);
  if (breakpoints.length === 0) return null;
  const sorted = [...breakpoints].sort(
    (a, b) => a.url.localeCompare(b.url) || a.lineNumber - b.lineNumber,
  );
  return (
    <div>
      <PaneHeader label={t('devtools.sources.pane.breakpoints')} count={breakpoints.length} />
      {sorted.map((bp) => {
        // Original-mode breakpoints display their mapped original url:line.
        const displayUrl = bp.original?.url ?? bp.url;
        const displayLine = (bp.original?.lineNumber ?? bp.lineNumber) + 1;
        return (
          <div
            key={`${bp.url}:${bp.lineNumber}`}
            className="group flex items-center gap-1 px-2 py-0.5 hover:bg-surface-2"
          >
            <button
              type="button"
              onClick={() => void useDevtoolsStore.getState().revealBreakpoint(bp)}
              title={displayUrl}
              className="flex-1 min-w-0 text-left font-mono text-caption text-fg-secondary truncate hover:text-fg-primary"
            >
              {scriptLabel(displayUrl)}
              <span className="text-fg-tertiary tabular-nums">:{displayLine}</span>
            </button>
            <button
              type="button"
              aria-label={`Remove breakpoint ${scriptLabel(displayUrl)}:${displayLine}`}
              title={t('devtools.sources.removeBreakpoint')}
              onClick={() =>
                void useDevtoolsStore.getState().toggleBreakpoint(bp.url, bp.lineNumber)
              }
              className="size-4 shrink-0 rounded items-center justify-center text-fg-tertiary hover:text-error hidden group-hover:flex"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ── XHR/fetch breakpoints (DOMDebugger) ──────────────────────────────── */

function XhrBreakpointsPane() {
  const { t } = useI18n();
  const xhrBreakpoints = useDevtoolsStore((s) => s.xhrBreakpoints);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const submit = () => {
    // The empty string is a valid breakpoint: break on ANY XHR/fetch.
    useDevtoolsStore.getState().addXhrBreakpoint(draft);
    setDraft('');
  };

  const enabledCount = xhrBreakpoints.filter((b) => b.enabled).length;
  return (
    <div>
      <CollapsiblePaneHeader
        label={t('devtools.sources.pane.xhrBreakpoints')}
        count={enabledCount}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open ? (
        <>
          <div className="px-1.5 py-1 flex items-center gap-1 border-b border-subtle/40">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('devtools.sources.xhrUrlPlaceholder')}
              aria-label={t('devtools.sources.breakWhenUrl')}
              className="h-6 flex-1 min-w-0 rounded bg-surface-2 px-2 text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-accent/50"
            />
            <button
              type="button"
              aria-label={t('devtools.sources.addXhrBreakpoint')}
              title={t('devtools.sources.addXhrBreakpoint')}
              onClick={submit}
              className="size-5 shrink-0 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
            >
              <Plus size={12} />
            </button>
          </div>
          {xhrBreakpoints.length === 0 ? (
            <div className="px-2 py-1 text-caption text-fg-tertiary">
              No XHR/fetch breakpoints
            </div>
          ) : (
            xhrBreakpoints.map((bp) => (
              <div
                key={bp.url}
                className="group flex items-center gap-1.5 px-2 py-0.5 hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  checked={bp.enabled}
                  onChange={(e) =>
                    useDevtoolsStore.getState().toggleXhrBreakpoint(bp.url, e.target.checked)
                  }
                  aria-label={`Enable breakpoint ${bp.url || 'Any XHR/fetch'}`}
                  className="accent-accent shrink-0"
                />
                <span
                  className={cn(
                    'flex-1 min-w-0 font-mono text-caption truncate',
                    bp.enabled ? 'text-fg-secondary' : 'text-fg-tertiary',
                  )}
                  title={bp.url || 'Any XHR/fetch'}
                >
                  {bp.url || 'Any XHR/fetch'}
                </span>
                <button
                  type="button"
                  aria-label={`Remove XHR/fetch breakpoint ${bp.url || 'Any XHR/fetch'}`}
                  title={t('devtools.sources.removeBreakpoint')}
                  onClick={() => useDevtoolsStore.getState().removeXhrBreakpoint(bp.url)}
                  className="size-4 shrink-0 rounded items-center justify-center text-fg-tertiary hover:text-error hidden group-hover:flex"
                >
                  <X size={11} />
                </button>
              </div>
            ))
          )}
        </>
      ) : null}
    </div>
  );
}

/* ── event listener breakpoints (DOMDebugger) ─────────────────────────── */

function EventBreakpointsPane() {
  const { t } = useI18n();
  const eventBreakpoints = useDevtoolsStore((s) => s.eventBreakpoints);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <CollapsiblePaneHeader
        label={t('devtools.sources.pane.eventBreakpoints')}
        count={eventBreakpoints.size}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open
        ? EVENT_BREAKPOINT_NAMES.map((name) => (
            <label
              key={name}
              className="flex items-center gap-1.5 px-2 py-0.5 text-caption text-fg-secondary cursor-pointer select-none hover:bg-surface-2"
            >
              <input
                type="checkbox"
                checked={eventBreakpoints.has(name)}
                onChange={(e) =>
                  useDevtoolsStore.getState().toggleEventBreakpoint(name, e.target.checked)
                }
                className="accent-accent shrink-0"
              />
              <span className="font-mono truncate">{name}</span>
            </label>
          ))
        : null}
    </div>
  );
}

/* ── script tree ──────────────────────────────────────────────────────── */

function ScriptsPane() {
  const { t } = useI18n();
  const scripts = useDevtoolsStore((s) => s.scripts);
  const sourceMaps = useDevtoolsStore((s) => s.sourceMaps);
  const selectedScriptId = useDevtoolsStore((s) => s.selectedScriptId);
  const original = useDevtoolsStore((s) => s.original);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const groups = useMemo(
    () => groupScriptsByOrigin(scripts.values(), filter),
    [scripts, filter],
  );

  const toggleGroup = (origin: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(origin)) next.delete(origin);
      else next.add(origin);
      return next;
    });

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-1.5 py-1 border-b border-subtle/40">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('devtools.sources.filterScripts')}
          aria-label={t('devtools.sources.filterScripts')}
          className="h-6 w-full rounded bg-surface-2 px-2 text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-accent/50"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="px-2 py-2 text-caption text-fg-tertiary">
            {scripts.size === 0 ? 'No scripts parsed yet' : 'No matching scripts'}
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.origin}>
              <button
                type="button"
                onClick={() => toggleGroup(g.origin)}
                title={g.origin}
                className="w-full flex items-center gap-1 px-1.5 py-0.5 text-caption text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2"
              >
                <ChevronRight
                  size={12}
                  className={cn(
                    'shrink-0 transition-transform',
                    !collapsed.has(g.origin) && 'rotate-90',
                  )}
                />
                <span className="truncate">{g.origin}</span>
              </button>
              {!collapsed.has(g.origin)
                ? g.scripts.map((s) => {
                    const rec = sourceMaps.get(s.scriptId);
                    const isSelected = s.scriptId === selectedScriptId;
                    return (
                      <div key={s.scriptId}>
                        <button
                          type="button"
                          onClick={() => void useDevtoolsStore.getState().openScript(s.scriptId)}
                          title={s.url}
                          className={cn(
                            'w-full text-left pl-6 pr-2 py-0.5 font-mono text-caption truncate',
                            isSelected && original === null
                              ? 'bg-accent-subtle/50 text-fg-primary'
                              : 'text-fg-secondary hover:bg-surface-2',
                          )}
                        >
                          {scriptLabel(s.url)}
                        </button>
                        {/* Mapped original sources, nested under their bundle. */}
                        {rec
                          ? rec.map.sources.slice(0, MAX_TREE_SOURCES).map((src, idx) => (
                              <button
                                key={`${s.scriptId}:${idx}`}
                                type="button"
                                onClick={() =>
                                  void useDevtoolsStore
                                    .getState()
                                    .selectOriginalSource(s.scriptId, idx)
                                }
                                title={rec.sourceUrls[idx] ?? src}
                                className={cn(
                                  'w-full text-left pl-9 pr-2 py-0.5 font-mono text-caption truncate',
                                  isSelected && original?.srcIndex === idx
                                    ? 'bg-accent-subtle/50 text-fg-primary'
                                    : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
                                )}
                              >
                                {scriptLabel(rec.sourceUrls[idx] ?? src)}
                              </button>
                            ))
                          : null}
                        {rec && rec.map.sources.length > MAX_TREE_SOURCES ? (
                          <div className="pl-9 pr-2 py-0.5 text-caption text-fg-tertiary tabular-nums">
                            Showing the first {MAX_TREE_SOURCES} of {rec.map.sources.length}{' '}
                            sources.
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ── source viewer ────────────────────────────────────────────────────── */

/**
 * Token kind → text class for the viewer's lightweight highlighting (syntax.ts).
 * Muted picks from the existing palette only: keywords ride the single accent,
 * strings the sage AI hue, numbers the blue one (both pre-muted at 0.72 alpha),
 * comments drop to tertiary + italic (the one sanctioned italic: code).
 * 'plain' renders without a span and inherits the pre's text-fg-primary.
 */
const TOKEN_CLASS: Record<Exclude<SyntaxTokenKind, 'plain'>, string> = {
  keyword: 'text-accent',
  string: 'text-ai-grep',
  number: 'text-ai-read',
  comment: 'text-fg-tertiary italic',
};

function SourceViewer() {
  const { t } = useI18n();
  const selectedScriptId = useDevtoolsStore((s) => s.selectedScriptId);
  const scripts = useDevtoolsStore((s) => s.scripts);
  const source = useDevtoolsStore((s) => s.scriptSource);
  const loading = useDevtoolsStore((s) => s.scriptSourceLoading);
  const sourceMaps = useDevtoolsStore((s) => s.sourceMaps);
  const original = useDevtoolsStore((s) => s.original);
  const breakpoints = useDevtoolsStore((s) => s.breakpoints);
  const paused = useDevtoolsStore((s) => s.paused);
  const reveal = useDevtoolsStore((s) => s.reveal);
  const scrollRef = useRef<HTMLDivElement>(null);

  const script = selectedScriptId ? (scripts.get(selectedScriptId) ?? null) : null;
  const url = script?.url ?? '';
  const mapRec = selectedScriptId ? (sourceMaps.get(selectedScriptId) ?? null) : null;
  const hasMap = mapRec !== null && mapRec.map.sources.length > 0;
  // Original mode is only meaningful once the map is resolved.
  const showingOriginal = original !== null && mapRec !== null;
  const displayUrl =
    showingOriginal && mapRec ? (mapRec.sourceUrls[original.srcIndex] ?? '') : url;
  const text = showingOriginal ? original.text : source;
  const textLoading = showingOriginal ? original.loading : loading;

  const { lines, truncatedLines } = useMemo(() => {
    if (text === null) return { lines: [] as string[], truncatedLines: false };
    const all = text.split('\n');
    if (all.length <= MAX_VIEW_LINES) return { lines: all, truncatedLines: false };
    return { lines: all.slice(0, MAX_VIEW_LINES), truncatedLines: true };
  }, [text]);

  // Per-line syntax tokens over the DISPLAYED text (lines clipped to
  // MAX_LINE_CHARS), so the concatenated token texts equal what's rendered.
  // tokenizeLines threads the block-comment/template carry across lines and
  // never throws (a bad line degrades to plain).
  const lineTokens = useMemo(
    () =>
      tokenizeLines(
        lines.map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) : l)),
      ),
    [lines],
  );

  // Breakpoint gutter markers: in original mode the lines of breakpoints set
  // from THIS original source; in compiled mode every breakpoint on the url
  // (including ones set from an original view, at their generated lines).
  const bpLines = useMemo(() => {
    const set = new Set<number>();
    if (showingOriginal) {
      for (const bp of breakpoints) {
        if (bp.original && bp.original.url === displayUrl) set.add(bp.original.lineNumber);
      }
    } else if (url) {
      for (const bp of breakpoints) if (bp.url === url) set.add(bp.lineNumber);
    }
    return set;
  }, [breakpoints, url, displayUrl, showingOriginal]);

  // The line the debugger is stopped at, when it's in the visible text —
  // mapped through the source map in original mode.
  const activeFrame = paused?.callFrames[paused.frameIndex];
  const pausedLine = useMemo(() => {
    if (!activeFrame || activeFrame.location.scriptId !== selectedScriptId) return null;
    if (!showingOriginal) return activeFrame.location.lineNumber;
    if (!mapRec || original === null) return null;
    const pos = originalPositionFor(
      mapRec.map,
      activeFrame.location.lineNumber,
      activeFrame.location.columnNumber ?? 0,
    );
    return pos && pos.srcIndex === original.srcIndex ? pos.line : null;
  }, [activeFrame, selectedScriptId, showingOriginal, mapRec, original]);

  // Scroll-to-reveal (pause location / call-stack click / breakpoint click).
  // `reveal.seq` bumps per request so the same line re-centers when asked again.
  useEffect(() => {
    if (!reveal || text === null) return;
    const el = scrollRef.current?.querySelector(`[data-line="${reveal.line}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
  }, [reveal, text]);

  if (!selectedScriptId) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        {t('devtools.sources.selectScript')}
      </div>
    );
  }

  const header = (
    <div className="shrink-0 flex items-center gap-2 px-2 py-0.5 border-b border-subtle/40">
      <span className="flex-1 min-w-0 text-caption text-fg-tertiary font-mono truncate">
        {displayUrl || '(unnamed script)'}
      </span>
      {hasMap ? (
        <div className="shrink-0 flex items-center rounded bg-surface-2 p-px">
          <button
            type="button"
            onClick={() => {
              const s = useDevtoolsStore.getState();
              if (s.original === null && s.selectedScriptId) {
                void s.selectOriginalSource(
                  s.selectedScriptId,
                  // Default to the first mapped source of the bundle.
                  mapRec && mapRec.map.mappings.length > 0
                    ? mapRec.map.mappings[0].srcIndex
                    : 0,
                );
              }
            }}
            className={cn(
              'h-4 px-1.5 rounded text-caption',
              showingOriginal
                ? 'bg-surface-3 text-fg-primary'
                : 'text-fg-tertiary hover:text-fg-secondary',
            )}
          >
            Original
          </button>
          <button
            type="button"
            onClick={() => useDevtoolsStore.getState().showCompiledSource()}
            className={cn(
              'h-4 px-1.5 rounded text-caption',
              !showingOriginal
                ? 'bg-surface-3 text-fg-primary'
                : 'text-fg-tertiary hover:text-fg-secondary',
            )}
          >
            Compiled
          </button>
        </div>
      ) : null}
    </div>
  );

  if (textLoading) {
    return (
      <div className="h-full flex flex-col min-h-0">
        {header}
        <div className="flex-1 flex items-center justify-center text-caption text-fg-tertiary">
          Loading source…
        </div>
      </div>
    );
  }
  if (text === null) {
    return (
      <div className="h-full flex flex-col min-h-0">
        {header}
        <div className="flex-1 flex items-center justify-center text-caption text-fg-tertiary">
          {showingOriginal ? 'Original source unavailable' : 'Source unavailable'}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {header}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
        {lines.map((line, i) => (
          <div
            key={i}
            data-line={i}
            // content-visibility skips layout/paint for off-screen lines so a
            // 10,000-line source stays smooth without a virtualization library.
            style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 18px' }}
            className={cn(
              'flex w-max min-w-full leading-[18px]',
              pausedLine === i && 'bg-accent-subtle/60',
            )}
          >
            <button
              type="button"
              disabled={!url}
              onClick={() =>
                showingOriginal
                  ? void useDevtoolsStore.getState().toggleOriginalBreakpoint(i)
                  : void useDevtoolsStore.getState().toggleBreakpoint(url, i)
              }
              title={
                url
                  ? bpLines.has(i)
                    ? 'Remove breakpoint'
                    : 'Add breakpoint'
                  : 'Breakpoints need a script URL'
              }
              className={cn(
                'sticky left-0 w-12 shrink-0 pr-2 text-right font-mono text-caption tabular-nums select-none border-r border-subtle/40',
                pausedLine === i ? 'bg-surface-2' : 'bg-surface-1',
                bpLines.has(i)
                  ? 'text-accent font-medium'
                  : 'text-fg-tertiary hover:text-fg-secondary',
              )}
            >
              {bpLines.has(i) ? '● ' : ''}
              {i + 1}
            </button>
            <pre className="flex-1 px-2 m-0 font-mono text-caption whitespace-pre text-fg-primary">
              {(lineTokens[i] ?? []).map((tok, j) =>
                tok.kind === 'plain' ? (
                  tok.text
                ) : (
                  <span key={j} className={TOKEN_CLASS[tok.kind]}>
                    {tok.text}
                  </span>
                ),
              )}
              {line.length > MAX_LINE_CHARS ? ' …' : ''}
            </pre>
          </div>
        ))}
        {truncatedLines ? (
          <div className="px-2 py-1 text-caption text-fg-tertiary tabular-nums">
            Showing the first {MAX_VIEW_LINES} lines.
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ── toolbar + panel ──────────────────────────────────────────────────── */

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="size-6 shrink-0 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-tertiary"
    >
      {children}
    </button>
  );
}

export function SourcesPanel() {
  const { t } = useI18n();
  const paused = useDevtoolsStore((s) => s.paused);
  const pauseOnExceptions = useDevtoolsStore((s) => s.pauseOnExceptions);
  const s = () => useDevtoolsStore.getState();
  const pausedLabel = paused ? pausedReasonLabel(paused.reason, paused.data) : null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-1 px-1.5 py-1 border-b border-subtle flex-wrap">
        {paused ? (
          <ToolbarButton label={t('devtools.sources.toolbar.resume')} onClick={() => s().resume()}>
            <Play size={14} />
          </ToolbarButton>
        ) : (
          <ToolbarButton label={t('devtools.sources.toolbar.pause')} onClick={() => s().pause()}>
            <Pause size={14} />
          </ToolbarButton>
        )}
        <ToolbarButton label={t('devtools.sources.toolbar.stepOver')} disabled={!paused} onClick={() => s().stepOver()}>
          <Redo2 size={14} />
        </ToolbarButton>
        <ToolbarButton label={t('devtools.sources.toolbar.stepInto')} disabled={!paused} onClick={() => s().stepInto()}>
          <ArrowDownToDot size={14} />
        </ToolbarButton>
        <ToolbarButton label={t('devtools.sources.toolbar.stepOut')} disabled={!paused} onClick={() => s().stepOut()}>
          <ArrowUpFromDot size={14} />
        </ToolbarButton>
        <div className="ml-auto">
          <select
            value={pauseOnExceptions}
            onChange={(e) => s().setPauseOnExceptions(e.target.value as PauseOnExceptions)}
            aria-label={t('devtools.sources.pauseOnExceptions')}
            className="h-6 rounded bg-surface-2 px-1 text-caption text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent/50"
          >
            {PAUSE_ON_EXCEPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {paused ? (
        <div className="shrink-0 flex items-center gap-2 px-2 py-1 bg-warning/10 border-b border-subtle text-caption text-warning">
          <span className="min-w-0 truncate" title={pausedLabel ?? undefined}>
            Paused{pausedLabel ? ` on ${pausedLabel}` : ''}.
          </span>
          <button
            type="button"
            onClick={() => s().resume()}
            className="ml-auto h-5 px-2 rounded text-caption text-fg-primary bg-surface-2 hover:bg-surface-3 transition-colors duration-fast"
          >
            Resume
          </button>
        </div>
      ) : null}

      <div className="flex-1 min-h-0 flex">
        <div className="w-56 shrink-0 border-r border-subtle flex flex-col min-h-0 overflow-y-auto">
          <CallStackPane />
          <ScopePane />
          <WatchPane />
          <BreakpointsPane />
          <XhrBreakpointsPane />
          <EventBreakpointsPane />
          <ScriptsPane />
        </div>
        <div className="flex-1 min-w-0">
          <SourceViewer />
        </div>
      </div>
    </div>
  );
}
