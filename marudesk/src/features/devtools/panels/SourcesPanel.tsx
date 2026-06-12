import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToDot,
  ArrowUpFromDot,
  ChevronRight,
  Pause,
  Play,
  Redo2,
  X,
} from 'lucide-react';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import { RemoteValue } from '../components/RemoteValue';
import { groupScriptsByOrigin, scriptLabel } from '../sources-utils';
import type {
  DebuggerCallFrame,
  DebuggerScope,
  PauseOnExceptions,
  RemoteObject,
} from '../types';

/**
 * Sources panel: a Debugger-domain script browser + breakpoint debugger. The
 * sidebar lists scripts grouped by origin (fed by `Debugger.scriptParsed`),
 * the viewer shows a read-only source with a breakpoint gutter, and the pause
 * machine (`Debugger.paused`/`resumed`, slice-sources) drives the banner, call
 * stack, and scope panes. Everything here speaks only Debugger/Runtime, so the
 * panel stays fully responsive while the page is paused.
 */

// Hard caps so a minified bundle can't melt the renderer: rows beyond the line
// cap are dropped (with a notice), and a single line is clipped to a width that
// still reads (content-visibility handles the vertical volume).
const MAX_VIEW_LINES = 10_000;
const MAX_LINE_CHARS = 4_000;
// The global scope can carry thousands of properties — preview the first slice.
const MAX_SCOPE_PROPS = 200;

const PAUSE_ON_EXCEPTIONS: { id: PauseOnExceptions; label: string }[] = [
  { id: 'none', label: "Don't pause on exceptions" },
  { id: 'uncaught', label: 'Pause on uncaught exceptions' },
  { id: 'all', label: 'Pause on all exceptions' },
];

const SCOPE_LABELS: Record<string, string> = {
  global: 'Global',
  local: 'Local',
  closure: 'Closure',
  block: 'Block',
  script: 'Script',
  module: 'Module',
  with: 'With',
  catch: 'Catch',
  'wasm-expression-stack': 'Stack',
};

function frameTitle(frame: DebuggerCallFrame): string {
  return frame.functionName || '(anonymous)';
}

function frameLocation(frame: DebuggerCallFrame): string {
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

/* ── call stack ───────────────────────────────────────────────────────── */

function CallStackPane() {
  const paused = useDevtoolsStore((s) => s.paused);
  if (!paused) return null;
  return (
    <div>
      <PaneHeader label="Call stack" count={paused.callFrames.length} />
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
            {frameLocation(frame)}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ── scope chain ──────────────────────────────────────────────────────── */

function ScopeSection({ scope, defaultOpen }: { scope: DebuggerScope; defaultOpen: boolean }) {
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

  const label = SCOPE_LABELS[scope.type] ?? scope.type;
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
            <span className="text-caption text-fg-tertiary">No variables</span>
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
  const paused = useDevtoolsStore((s) => s.paused);
  const frame = paused?.callFrames[paused.frameIndex];
  if (!paused || !frame) return null;
  return (
    <div>
      <PaneHeader label="Scope" />
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

/* ── breakpoints ──────────────────────────────────────────────────────── */

function BreakpointsPane() {
  const breakpoints = useDevtoolsStore((s) => s.breakpoints);
  if (breakpoints.length === 0) return null;
  const sorted = [...breakpoints].sort(
    (a, b) => a.url.localeCompare(b.url) || a.lineNumber - b.lineNumber,
  );
  return (
    <div>
      <PaneHeader label="Breakpoints" count={breakpoints.length} />
      {sorted.map((bp) => (
        <div
          key={`${bp.url}:${bp.lineNumber}`}
          className="group flex items-center gap-1 px-2 py-0.5 hover:bg-surface-2"
        >
          <button
            type="button"
            onClick={() => void useDevtoolsStore.getState().revealBreakpoint(bp)}
            title={bp.url}
            className="flex-1 min-w-0 text-left font-mono text-caption text-fg-secondary truncate hover:text-fg-primary"
          >
            {scriptLabel(bp.url)}
            <span className="text-fg-tertiary tabular-nums">:{bp.lineNumber + 1}</span>
          </button>
          <button
            type="button"
            aria-label={`Remove breakpoint ${scriptLabel(bp.url)}:${bp.lineNumber + 1}`}
            title="Remove breakpoint"
            onClick={() =>
              void useDevtoolsStore.getState().toggleBreakpoint(bp.url, bp.lineNumber)
            }
            className="size-4 shrink-0 rounded items-center justify-center text-fg-tertiary hover:text-error hidden group-hover:flex"
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── script tree ──────────────────────────────────────────────────────── */

function ScriptsPane() {
  const scripts = useDevtoolsStore((s) => s.scripts);
  const selectedScriptId = useDevtoolsStore((s) => s.selectedScriptId);
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
          placeholder="Filter scripts"
          aria-label="Filter scripts"
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
                ? g.scripts.map((s) => (
                    <button
                      key={s.scriptId}
                      type="button"
                      onClick={() => void useDevtoolsStore.getState().selectScript(s.scriptId)}
                      title={s.url}
                      className={cn(
                        'w-full text-left pl-6 pr-2 py-0.5 font-mono text-caption truncate',
                        s.scriptId === selectedScriptId
                          ? 'bg-accent-subtle/50 text-fg-primary'
                          : 'text-fg-secondary hover:bg-surface-2',
                      )}
                    >
                      {scriptLabel(s.url)}
                    </button>
                  ))
                : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ── source viewer ────────────────────────────────────────────────────── */

function SourceViewer() {
  const selectedScriptId = useDevtoolsStore((s) => s.selectedScriptId);
  const scripts = useDevtoolsStore((s) => s.scripts);
  const source = useDevtoolsStore((s) => s.scriptSource);
  const loading = useDevtoolsStore((s) => s.scriptSourceLoading);
  const breakpoints = useDevtoolsStore((s) => s.breakpoints);
  const paused = useDevtoolsStore((s) => s.paused);
  const reveal = useDevtoolsStore((s) => s.reveal);
  const scrollRef = useRef<HTMLDivElement>(null);

  const script = selectedScriptId ? (scripts.get(selectedScriptId) ?? null) : null;
  const url = script?.url ?? '';

  const { lines, truncatedLines } = useMemo(() => {
    if (source === null) return { lines: [] as string[], truncatedLines: false };
    const all = source.split('\n');
    if (all.length <= MAX_VIEW_LINES) return { lines: all, truncatedLines: false };
    return { lines: all.slice(0, MAX_VIEW_LINES), truncatedLines: true };
  }, [source]);

  const bpLines = useMemo(() => {
    const set = new Set<number>();
    if (url) {
      for (const bp of breakpoints) if (bp.url === url) set.add(bp.lineNumber);
    }
    return set;
  }, [breakpoints, url]);

  // The line the debugger is stopped at, when it's in the visible script.
  const activeFrame = paused?.callFrames[paused.frameIndex];
  const pausedLine =
    activeFrame && activeFrame.location.scriptId === selectedScriptId
      ? activeFrame.location.lineNumber
      : null;

  // Scroll-to-reveal (pause location / call-stack click / breakpoint click).
  // `reveal.seq` bumps per request so the same line re-centers when asked again.
  useEffect(() => {
    if (!reveal || source === null) return;
    const el = scrollRef.current?.querySelector(`[data-line="${reveal.line}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
  }, [reveal, source]);

  if (!selectedScriptId) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        Select a script to view its source
      </div>
    );
  }
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        Loading source…
      </div>
    );
  }
  if (source === null) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        Source unavailable
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 px-2 py-0.5 text-caption text-fg-tertiary font-mono truncate border-b border-subtle/40">
        {url || '(unnamed script)'}
      </div>
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
              onClick={() => void useDevtoolsStore.getState().toggleBreakpoint(url, i)}
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
              {bpLines.has(i) ? '● ' : ''}
              {i + 1}
            </button>
            <pre className="flex-1 px-2 m-0 font-mono text-caption whitespace-pre text-fg-primary">
              {line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} …` : line}
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
  const paused = useDevtoolsStore((s) => s.paused);
  const pauseOnExceptions = useDevtoolsStore((s) => s.pauseOnExceptions);
  const s = () => useDevtoolsStore.getState();

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-1 px-1.5 py-1 border-b border-subtle flex-wrap">
        {paused ? (
          <ToolbarButton label="Resume script execution" onClick={() => s().resume()}>
            <Play size={14} />
          </ToolbarButton>
        ) : (
          <ToolbarButton label="Pause script execution" onClick={() => s().pause()}>
            <Pause size={14} />
          </ToolbarButton>
        )}
        <ToolbarButton label="Step over next function call" disabled={!paused} onClick={() => s().stepOver()}>
          <Redo2 size={14} />
        </ToolbarButton>
        <ToolbarButton label="Step into next function call" disabled={!paused} onClick={() => s().stepInto()}>
          <ArrowDownToDot size={14} />
        </ToolbarButton>
        <ToolbarButton label="Step out of current function" disabled={!paused} onClick={() => s().stepOut()}>
          <ArrowUpFromDot size={14} />
        </ToolbarButton>
        <div className="ml-auto">
          <select
            value={pauseOnExceptions}
            onChange={(e) => s().setPauseOnExceptions(e.target.value as PauseOnExceptions)}
            aria-label="Pause on exceptions"
            className="h-6 rounded bg-surface-2 px-1 text-caption text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent/50"
          >
            {PAUSE_ON_EXCEPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {paused ? (
        <div className="shrink-0 flex items-center gap-2 px-2 py-1 bg-warning/10 border-b border-subtle text-caption text-warning">
          <span>
            Paused
            {paused.reason && paused.reason !== 'other' ? ` on ${paused.reason}` : ''}.
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
          <BreakpointsPane />
          <ScriptsPane />
        </div>
        <div className="flex-1 min-w-0">
          <SourceViewer />
        </div>
      </div>
    </div>
  );
}
