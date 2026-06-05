import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bug,
  Code,
  FileText,
  Globe,
  Image,
  LayoutDashboard,
  Paperclip,
  Settings,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import { useWebPageStore } from '../browser/store';
import { useTabsStore } from '../tabs/store';
import { CaptureRow, ContextSection, EmptyHint, TabRow } from './ContextPopoverRows';
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
  onAddPhoto: () => void;
  onAddFile: () => void;
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
export function ContextPopover({ anchorRef, onClose, onInsertMention, onAddPhoto, onAddFile }: Props) {
  const { t } = useI18n();
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
      aria-label={t('agent.context.addContext')}
      style={{ left: pos?.left ?? 8, top: pos?.top, visibility: pos ? undefined : 'hidden' }}
      className={cn(
        'fixed z-50 w-72 -translate-y-full mb-1',
        // L2 "soft glow" is the design system's popover elevation (§6); shadow-xl
        // was an off-system Tailwind default.
        'rounded-lg border border-default bg-surface-1 shadow-glow',
        'flex flex-col overflow-hidden',
        'text-body-sm',
      )}
    >
      {/* ── Captures section ──────────────────────────────────────────── */}
      <div className="flex flex-col py-1">
        <button
          type="button"
          onClick={onAddPhoto}
          className="flex items-center gap-2 px-3 py-1.5 text-left text-body-sm text-fg-secondary hover:bg-surface-3/60 hover:text-fg-primary transition-colors duration-fast"
        >
          <Image size={13} className="shrink-0 text-fg-tertiary" />
          <span>{t('agent.context.addPhoto')}</span>
        </button>
        <button
          type="button"
          onClick={onAddFile}
          className="flex items-center gap-2 px-3 py-1.5 text-left text-body-sm text-fg-secondary hover:bg-surface-3/60 hover:text-fg-primary transition-colors duration-fast"
        >
          <Paperclip size={13} className="shrink-0 text-fg-tertiary" />
          <span>{t('agent.context.addFile')}</span>
        </button>
      </div>

      <div className="h-px bg-surface-3 shrink-0" />

      <ContextSection label={t('agent.context.captures')}>
        {!hasCaptures ? (
          <EmptyHint>
            {t('agent.context.noCaptures')}
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
      </ContextSection>

      <div className="h-px bg-surface-3 shrink-0" />

      {/* ── Open tabs section ─────────────────────────────────────────── */}
      <ContextSection label={t('agent.context.openTabsFiles')}>
        {!hasTabs ? (
          <EmptyHint>{t('agent.context.noOpenTabs')}</EmptyHint>
        ) : (
          tabs.map((tab) => {
            const Icon = tabIcon(tab.kind);
            const mention = tabMention(tab);
            const display = tab.title || (tab.kind === 'editor' && tab.filePath) || tab.url || kindLabel(tab.kind);
            return (
              <TabRow
                key={tab.id}
                icon={<Icon size={12} />}
                kind={kindLabel(tab.kind)}
                label={String(display)}
                title={`${t('agent.context.insertMentionBefore')}${kindLabel(tab.kind)}${t(
                  'agent.context.insertMentionAfter',
                )}`}
                onClick={() => {
                  onInsertMention(mention);
                  onClose();
                }}
              />
            );
          })
        )}
      </ContextSection>

      <div className="h-px bg-surface-3 shrink-0" />

      {/* ── Built-in context MCP ──────────────────────────────────────── */}
      <div className="flex flex-col">
        <div className="px-3 pt-2 pb-1 flex items-center gap-1.5 text-caption uppercase tracking-wider text-fg-tertiary">
          <Sparkles size={11} className="text-accent" />
          <span>{t('agent.context.builtinTitle')}</span>
        </div>
        <p className="px-3 pb-2 text-caption text-fg-tertiary leading-relaxed">
          {t('agent.context.builtinBody')}
        </p>
      </div>
    </div>,
    document.body,
  );
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'web':
      return 'web';
    case 'home':
      return 'home';
    case 'terminal':
      return 'terminal';
    case 'editor':
      return 'editor';
    case 'settings':
      return 'settings';
    case 'agent':
      return 'agent';
    default:
      return kind;
  }
}
