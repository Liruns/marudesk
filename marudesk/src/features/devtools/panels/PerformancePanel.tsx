import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Circle, RefreshCw, Square } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import {
  curateMetrics,
  formatMs,
  type ProcessedProfile,
  type ProfileFrame,
} from '../performance-utils';
import { scriptLabel } from '../sources-utils';

/**
 * Performance panel: live page metrics (Performance.getMetrics, pulled — a
 * Refresh button plus a light poll while the panel is mounted) and a sampling
 * CPU profiler (Profiler.start/stop) whose result renders as a switchable
 * Top-down call tree / Bottom-up self-time table (processed in
 * performance-utils). Recording state lives in slice-performance and is dropped
 * on navigation/detach there — the panel itself holds only view state.
 */

// Light metrics poll while the panel is visible (the interval dies with the
// mount, so nothing leaks across detach — PanelById unmounts hidden panels).
const METRICS_POLL_MS = 2000;
// Render caps so a huge profile can't melt the renderer.
const MAX_TREE_ROWS = 2000;
const MAX_BOTTOM_UP_ROWS = 500;

type ProfileView = 'top-down' | 'bottom-up';

const PROFILE_VIEWS: { id: ProfileView; label: string }[] = [
  { id: 'top-down', label: 'Top-down' },
  { id: 'bottom-up', label: 'Bottom-up' },
];

/** Section header shared by the metrics and profiler areas. */
function SectionHeader({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="shrink-0 px-2 py-1 text-caption font-medium text-fg-tertiary bg-surface-2/40 border-y border-subtle/40 flex items-center gap-2">
      {label}
      {detail ? <span className="font-normal tabular-nums">{detail}</span> : null}
    </div>
  );
}

/** `file.js:12` location tail for a frame, '' for extension-less frames. */
function frameLocation(f: { url: string; lineNumber: number }): string {
  if (!f.url) return '';
  return f.lineNumber >= 0 ? `${scriptLabel(f.url)}:${f.lineNumber + 1}` : scriptLabel(f.url);
}

/* ── live metrics ─────────────────────────────────────────────────────── */

function MetricsSection() {
  const metrics = useDevtoolsStore((s) => s.perfMetrics);
  const updatedAt = useDevtoolsStore((s) => s.perfMetricsAt);
  const rows = useMemo(() => curateMetrics(metrics ?? []), [metrics]);
  const detail = updatedAt
    ? `Updated ${new Date(updatedAt).toTimeString().slice(0, 8)}`
    : undefined;
  return (
    <div>
      <SectionHeader label="Live metrics" detail={detail} />
      {rows.length === 0 ? (
        <div className="px-3 py-2 text-caption text-fg-tertiary">
          No metrics yet. Refresh to read the current values.
        </div>
      ) : (
        <div className="px-3 py-2 grid grid-cols-2 gap-x-8 gap-y-0.5 max-w-xl">
          {rows.map((r) => (
            <div key={r.name} className="flex items-baseline justify-between gap-3 text-caption">
              <span className="text-fg-tertiary">{r.label}</span>
              <span className="font-mono tabular-nums text-fg-primary">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── profile tables ───────────────────────────────────────────────────── */

function ColumnHeader() {
  return (
    <div className="sticky top-0 flex items-center bg-surface-1 text-caption text-fg-tertiary border-b border-subtle/40">
      <span className="w-24 shrink-0 px-2 py-1 text-right">Self time</span>
      <span className="w-24 shrink-0 px-2 py-1 text-right">Total time</span>
      <span className="flex-1 px-2 py-1">Function</span>
    </div>
  );
}

function TimeCell({ ms, total }: { ms: number; total: number }) {
  const pct = total > 0 ? (ms / total) * 100 : 0;
  return (
    <span className="w-24 shrink-0 px-2 text-right font-mono text-caption tabular-nums text-fg-secondary whitespace-nowrap">
      {formatMs(ms)}
      <span className="text-fg-tertiary"> {pct.toFixed(1)}%</span>
    </span>
  );
}

type TreeRow = { frame: ProfileFrame; depth: number };

/** Flatten the expanded part of the tree into rows, capped at MAX_TREE_ROWS. */
function flattenVisible(
  root: ProfileFrame,
  expanded: ReadonlySet<number>,
): { rows: TreeRow[]; truncated: boolean } {
  const rows: TreeRow[] = [];
  const stack: TreeRow[] = [];
  for (let i = root.children.length - 1; i >= 0; i--) {
    stack.push({ frame: root.children[i], depth: 0 });
  }
  while (stack.length > 0) {
    if (rows.length >= MAX_TREE_ROWS) return { rows, truncated: true };
    const row = stack.pop();
    if (!row) break;
    rows.push(row);
    if (expanded.has(row.frame.id)) {
      for (let i = row.frame.children.length - 1; i >= 0; i--) {
        stack.push({ frame: row.frame.children[i], depth: row.depth + 1 });
      }
    }
  }
  return { rows, truncated: false };
}

function TopDownTree({ profile }: { profile: ProcessedProfile }) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  // A new recording starts with a fresh (collapsed) tree — adjust state during
  // render (the React-endorsed reset pattern) instead of an effect.
  const [prevProfile, setPrevProfile] = useState(profile);
  if (prevProfile !== profile) {
    setPrevProfile(profile);
    setExpanded(new Set());
  }

  const { rows, truncated } = useMemo(
    () => flattenVisible(profile.root, expanded),
    [profile, expanded],
  );

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (rows.length === 0) {
    return <div className="px-3 py-2 text-caption text-fg-tertiary">No samples recorded.</div>;
  }
  return (
    <div>
      <ColumnHeader />
      {rows.map(({ frame, depth }) => {
        const hasChildren = frame.children.length > 0;
        return (
          <div
            key={frame.id}
            className="flex items-center min-w-0 leading-[20px] hover:bg-surface-2"
          >
            <TimeCell ms={frame.selfTime} total={profile.durationMs} />
            <TimeCell ms={frame.totalTime} total={profile.durationMs} />
            <button
              type="button"
              disabled={!hasChildren}
              onClick={() => toggle(frame.id)}
              style={{ paddingLeft: depth * 14 }}
              className="flex-1 min-w-0 flex items-center gap-1 px-2 text-left"
            >
              <ChevronRight
                size={12}
                className={cn(
                  'shrink-0 text-fg-tertiary transition-transform',
                  !hasChildren && 'invisible',
                  expanded.has(frame.id) && 'rotate-90',
                )}
              />
              <span className="font-mono text-caption text-fg-primary truncate">
                {frame.functionName}
              </span>
              {frame.url ? (
                <span
                  title={frame.url}
                  className="font-mono text-caption text-fg-tertiary tabular-nums truncate"
                >
                  {frameLocation(frame)}
                </span>
              ) : null}
            </button>
          </div>
        );
      })}
      {truncated ? (
        <div className="px-3 py-1 text-caption text-fg-tertiary tabular-nums">
          Showing the first {MAX_TREE_ROWS} rows. Collapse branches to see more.
        </div>
      ) : null}
    </div>
  );
}

function BottomUpTable({ profile }: { profile: ProcessedProfile }) {
  const rows = profile.bottomUp.slice(0, MAX_BOTTOM_UP_ROWS);
  if (rows.length === 0) {
    return <div className="px-3 py-2 text-caption text-fg-tertiary">No samples recorded.</div>;
  }
  return (
    <div>
      <ColumnHeader />
      {rows.map((row) => (
        <div
          key={`${row.functionName} ${row.url} ${row.lineNumber}`}
          className="flex items-center min-w-0 leading-[20px] hover:bg-surface-2"
        >
          <TimeCell ms={row.selfTime} total={profile.durationMs} />
          <TimeCell ms={row.totalTime} total={profile.durationMs} />
          <span className="flex-1 min-w-0 flex items-center gap-1 px-2">
            <span className="font-mono text-caption text-fg-primary truncate">
              {row.functionName}
            </span>
            {row.url ? (
              <span
                title={row.url}
                className="font-mono text-caption text-fg-tertiary tabular-nums truncate"
              >
                {frameLocation(row)}
              </span>
            ) : null}
          </span>
        </div>
      ))}
      {profile.bottomUp.length > MAX_BOTTOM_UP_ROWS ? (
        <div className="px-3 py-1 text-caption text-fg-tertiary tabular-nums">
          Showing the first {MAX_BOTTOM_UP_ROWS} of {profile.bottomUp.length} functions.
        </div>
      ) : null}
    </div>
  );
}

/* ── panel ────────────────────────────────────────────────────────────── */

export function PerformancePanel() {
  const profiling = useDevtoolsStore((s) => s.profiling);
  const profile = useDevtoolsStore((s) => s.profile);
  const [view, setView] = useState<ProfileView>('top-down');

  // Refresh metrics on mount, then poll lightly while the panel is visible.
  // refreshMetrics no-ops unless the session is attached, so the interval is
  // harmless across the attaching/detached gates.
  useEffect(() => {
    const tick = () => void useDevtoolsStore.getState().refreshMetrics();
    tick();
    const id = window.setInterval(tick, METRICS_POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-1 px-1.5 py-1 border-b border-subtle flex-wrap">
        {profiling ? (
          <button
            type="button"
            onClick={() => void useDevtoolsStore.getState().stopProfiling()}
            className="h-6 px-2 rounded text-caption flex items-center gap-1.5 text-error bg-error/10 hover:bg-error/20 transition-colors duration-fast"
          >
            <Square size={11} />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void useDevtoolsStore.getState().startProfiling()}
            className="h-6 px-2 rounded text-caption flex items-center gap-1.5 text-fg-secondary hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast"
          >
            <Circle size={11} />
            Record
          </button>
        )}
        {profile ? (
          <div className="flex items-center gap-0.5 ml-1">
            {PROFILE_VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={view === v.id}
                onClick={() => setView(v.id)}
                className={cn(
                  'h-6 px-2 rounded text-caption transition-colors duration-fast',
                  view === v.id
                    ? 'bg-surface-page text-fg-primary'
                    : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex-1" />
        <button
          type="button"
          aria-label="Refresh metrics"
          title="Refresh metrics"
          onClick={() => void useDevtoolsStore.getState().refreshMetrics()}
          className="size-6 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <MetricsSection />
        <SectionHeader
          label="CPU profile"
          detail={profile ? `${formatMs(profile.durationMs)} recorded` : undefined}
        />
        {profiling ? (
          <div className="px-3 py-2 text-caption text-fg-secondary">
            Recording CPU profile. Interact with the page, then press Stop.
          </div>
        ) : profile ? (
          view === 'top-down' ? (
            <TopDownTree profile={profile} />
          ) : (
            <BottomUpTable profile={profile} />
          )
        ) : (
          <div className="px-3 py-2 text-caption text-fg-tertiary">
            Record a CPU profile to see where script time is spent.
          </div>
        )}
      </div>
    </div>
  );
}
