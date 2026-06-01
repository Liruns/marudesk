import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bug,
  Code,
  FileText,
  Globe,
  LayoutDashboard,
  Plus,
  Settings,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useWebPageStore } from '../browser/store';
import { useTabsStore } from '../tabs/store';
import type { Capture } from '../../../shared/capture';
import type { TabState } from '../../../shared/browser';

/* ── Tab kind → icon ───────────────────────────────────────────────────── */

const TAB_KIND_ICON: Record<string, LucideIcon> = {
  web: Globe,
  home: LayoutDashboard,
  terminal: SquareTerminal,
  editor: FileText,
  settings: Settings,
  agent: Code,
};

function tabIcon(kind: string): LucideIcon {
  return TAB_KIND_ICON[kind] ?? Globe;
}

/* ── Capture label helper ──────────────────────────────────────────────── */

function captureLabel(c: Capture): string {
  if (c.kind === 'console-error') {
    const short = c.message.split('\n')[0];
    return short.length > 60 ? short.slice(0, 60) + '…' : short;
  }
  const sel = c.selector || c.tagName;
  return sel.length > 60 ? sel.slice(0, 60) + '…' : sel;
}

function captureKindLabel(c: Capture): string {
  return c.kind === 'console-error' ? 'error' : c.tagName.toLowerCase();
}

/* ── Tab mention helper ────────────────────────────────────────────────── */

function tabMention(tab: TabState): string {
  if (tab.kind === 'editor' && tab.filePath) return `@${tab.filePath}`;
  if (tab.kind === 'web' && tab.url) return `@${tab.url}`;
  return `@${tab.title || tab.kind}`;
}

/* ── Props ─────────────────────────────────────────────────────────────── */

type Props = {
  /**
   * The button element that triggered the popover — used to position it just
   * above the composer toolbar so it never overlaps the textarea.
   */
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  /** Insert text at the cursor in the draft textarea. */
  onInsertMention: (text: string) => void;
};

/**
 * "+" context popover for the AI Chat composer (agentic-chat-v4 Track B §B3).
 *
 * Two sections:
 *  1. Captures — current page captures (element / console-error). Checkboxes are
 *     bound to `selectedCaptureIds`; the existing `toggleCaptureSelected` action
 *     is the only write path. Selected captures already flow to the agent's first
 *     turn via `agent/store.ts send()`, so surfacing selection here is purely
 *     presentational.
 *  2. Open tabs — each tab inserts an @-style mention into the draft on click
 *     (e.g. `@src/App.tsx`, `@https://…`). No selection state — just a nudge
 *     that the agent can fetch context from that target on demand.
 *
 * Closes on outside pointer-down, Escape, or scroll — same dismiss contract as
 * the existing {@link ContextMenu} component.
 */
export function ContextPopover({ anchorRef, onClose, onInsertMention }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const captures = useWebPageStore((s) => s.captures);
  const selectedIds = useWebPageStore((s) => s.selectedCaptureIds);
  const toggleCapture = useWebPageStore((s) => s.toggleCaptureSelected);

  const tabs = useTabsStore((s) => s.tabs);

  /* ── Position above the anchor button ────────────────────────────────── */

  // Measured once after mount (refs must not be read during render). The popover
  // closes on scroll/resize, so a single measurement is enough; it stays hidden
  // until measured to avoid a flash at (0,0). `top` is the anchor's top edge —
  // the -translate-y-full className opens the popover upward from there.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPos({ left: Math.max(8, rect.left), top: rect.top });
  }, [anchorRef]);

  /* ── Dismiss on outside pointer-down / Esc / scroll ─────────────────── */

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const anchor = anchorRef.current;
      if (
        ref.current &&
        !ref.current.contains(e.target as Node) &&
        !(anchor && anchor.contains(e.target as Node))
      ) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onScroll = () => onClose();

    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [anchorRef, onClose]);

  /* ── Render ─────────────────────────────────────────────────────────── */

  const hasCaptures = captures.length > 0;
  const hasTabs = tabs.length > 0;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Add context"
      style={{ left: pos?.left ?? 8, top: pos?.top, visibility: pos ? undefined : 'hidden' }}
      className={cn(
        'fixed z-50 w-72 -translate-y-full mb-1',
        'rounded-lg border border-default bg-surface-1 shadow-xl',
        'flex flex-col overflow-hidden',
        'text-body-sm',
      )}
    >
      {/* ── Captures section ──────────────────────────────────────────── */}
      <Section label="Captures">
        {!hasCaptures ? (
          <EmptyHint>
            No captures yet — toggle Inspect and click any element in the
            browser to capture it.
          </EmptyHint>
        ) : (
          captures.map((c) => {
            const selected = selectedIds.has(c.id);
            const Icon = c.kind === 'console-error' ? Bug : Code;
            return (
              <CaptureRow
                key={c.id}
                icon={<Icon size={12} />}
                kind={captureKindLabel(c)}
                label={captureLabel(c)}
                selected={selected}
                onToggle={() => toggleCapture(c.id)}
              />
            );
          })
        )}
      </Section>

      <div className="h-px bg-surface-3 shrink-0" />

      {/* ── Open tabs section ─────────────────────────────────────────── */}
      <Section label="Open tabs / files">
        {!hasTabs ? (
          <EmptyHint>No open tabs.</EmptyHint>
        ) : (
          tabs.map((t) => {
            const Icon = tabIcon(t.kind);
            const mention = tabMention(t);
            const display = t.title || (t.kind === 'editor' && t.filePath) || t.url || t.kind;
            return (
              <TabRow
                key={t.id}
                icon={<Icon size={12} />}
                kind={t.kind}
                label={String(display)}
                onClick={() => {
                  onInsertMention(mention);
                  onClose();
                }}
              />
            );
          })
        )}
      </Section>

      <div className="h-px bg-surface-3 shrink-0" />

      {/* ── Built-in context MCP ──────────────────────────────────────── */}
      <div className="flex flex-col">
        <div className="px-3 pt-2 pb-1 flex items-center gap-1.5 text-caption uppercase tracking-wider text-fg-tertiary">
          <Sparkles size={11} className="text-accent" />
          <span>Built-in context · MCP</span>
        </div>
        <p className="px-3 pb-2 text-caption text-fg-tertiary leading-relaxed">
          The agent pulls these on demand: page text &amp; DOM, network,
          cookies/storage, open editors (incl. unsaved), terminals, the file
          tree, previous sessions, and memory.
        </p>
      </div>
    </div>,
    document.body,
  );
}

/* ── Sub-components ─────────────────────────────────────────────────────── */

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="px-3 pt-2 pb-1 text-caption uppercase tracking-wider text-fg-tertiary">
        {label}
      </div>
      <div className="flex flex-col pb-1 max-h-40 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 py-1.5 text-caption text-fg-tertiary leading-relaxed">
      {children}
    </p>
  );
}

function CaptureRow({
  icon,
  kind,
  label,
  selected,
  onToggle,
}: {
  icon: React.ReactNode;
  kind: string;
  label: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 h-7 text-left',
        'transition-colors duration-fast',
        'hover:bg-surface-2 focus:bg-surface-2 outline-none',
        selected ? 'text-fg-primary' : 'text-fg-secondary',
      )}
    >
      {/* Checkbox indicator */}
      <span
        aria-hidden
        className={cn(
          'size-3.5 shrink-0 rounded border flex items-center justify-center',
          selected
            ? 'bg-accent border-accent text-white'
            : 'border-default bg-surface-page',
        )}
      >
        {selected ? (
          <svg viewBox="0 0 10 8" width={8} height={8} fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M1 4l3 3 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>

      <span className="shrink-0 text-fg-tertiary">{icon}</span>

      <span className="text-caption text-fg-tertiary shrink-0 w-10 truncate">
        {kind}
      </span>

      <span className="flex-1 min-w-0 truncate text-caption">{label}</span>
    </button>
  );
}

function TabRow({
  icon,
  kind,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  kind: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Insert mention for this ${kind} tab`}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 h-7 text-left',
        'transition-colors duration-fast',
        'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
        'focus:bg-surface-2 focus:text-fg-primary outline-none',
      )}
    >
      <span className="shrink-0 text-fg-tertiary">{icon}</span>
      <span className="text-caption text-fg-tertiary shrink-0 w-10 truncate">
        {kind}
      </span>
      <span className="flex-1 min-w-0 truncate text-caption">{label}</span>
      <Plus size={10} className="shrink-0 text-fg-tertiary/60" />
    </button>
  );
}
