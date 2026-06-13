import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bug,
  Code,
  FileText,
  Globe,
  Image,
  Paperclip,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import { useWebPageStore } from '../browser/store';
import { useTabsStore } from '../tabs/store';
import { CaptureRow, ContextSection, TabRow } from './ContextPopoverRows';
import type { Capture } from '../../../shared/capture';
import type { TabState } from '../../../shared/browser';

/* ── Tab kind → icon ───────────────────────────────────────────────────── */

const TAB_KIND_ICON: Record<string, LucideIcon> = {
  web: Globe,
  terminal: SquareTerminal,
  editor: FileText,
};

function tabIcon(kind: string): LucideIcon {
  return TAB_KIND_ICON[kind] ?? Globe;
}

/**
 * Tab kinds worth mentioning to the agent — a URL, a file, or a terminal the
 * agent can read. Home/settings/agent tabs produced useless `@home` mentions
 * and only padded the list.
 */
const MENTIONABLE_TAB_KINDS = new Set(['web', 'editor', 'terminal']);

/* ── Capture label helper ──────────────────────────────────────────────── */

function captureLabel(c: Capture): string {
  if (c.kind === 'console-error' || c.kind === 'terminal-error') {
    const short = c.message.split('\n')[0];
    return short.length > 60 ? short.slice(0, 60) + '…' : short;
  }
  const sel = c.selector || c.tagName;
  return sel.length > 60 ? sel.slice(0, 60) + '…' : sel;
}

function captureKindLabel(c: Capture): string {
  if (c.kind === 'console-error') return 'error';
  if (c.kind === 'terminal-error') return 'terminal';
  return c.tagName.toLowerCase();
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
 * Always shows the two attach actions (photo / file); the Captures and Open
 * tabs sections appear only when they have content:
 *  1. Captures — current page captures (element / console-error). Checkboxes
 *     are bound to `selectedCaptureIds`; the existing `toggleCaptureSelected`
 *     action is the only write path. Selected captures already flow to the
 *     agent's first turn via `agent/store.ts send()`.
 *  2. Open tabs — web/editor/terminal tabs only; each inserts an @-style
 *     mention into the draft on click (e.g. `@src/App.tsx`, `@https://…`).
 *
 * Keyboard: ArrowUp/ArrowDown move between rows (focus lands on the first row
 * when the popover opens), Enter activates, Escape closes. Also closes on
 * outside pointer-down or scroll — same dismiss contract as {@link ContextMenu}.
 */
export function ContextPopover({ anchorRef, onClose, onInsertMention, onAddPhoto, onAddFile }: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);

  const captures = useWebPageStore((s) => s.captures);
  const selectedIds = useWebPageStore((s) => s.selectedCaptureIds);
  const toggleCapture = useWebPageStore((s) => s.toggleCaptureSelected);

  const allTabs = useTabsStore((s) => s.tabs);
  const tabs = allTabs.filter((tab) => MENTIONABLE_TAB_KINDS.has(tab.kind));

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
    // Clamp into the viewport: in a narrow split pane / drawer the anchor can sit
    // closer to the window's right edge than the popover is wide (w-72 = 288px).
    const popoverWidth = 288;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth - 8));
    setPos({ left, top: rect.top });
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
    // Outside scroll moves the anchor, so close — but scrolling a section
    // INSIDE the popover (captures/tabs overflow, or arrow-key focus pulling a
    // row into view) must not dismiss it.
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };

    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [anchorRef, onClose]);

  /* ── Keyboard: arrows walk the rows, Enter activates (native button) ── */

  // Focus the first row once positioned, so arrows work immediately.
  useEffect(() => {
    if (pos) ref.current?.querySelector('button')?.focus();
  }, [pos]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const root = ref.current;
    if (!root) return;
    e.preventDefault();
    const rows = Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
    if (rows.length === 0) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown'
        ? (current + 1) % rows.length
        : (current - 1 + rows.length) % rows.length;
    rows[next]?.focus();
  };

  /* ── Render ─────────────────────────────────────────────────────────── */

  const hasCaptures = captures.length > 0;
  const hasTabs = tabs.length > 0;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={t('agent.context.addContext')}
      onKeyDown={onKeyDown}
      style={{ left: pos?.left ?? 8, top: pos?.top, visibility: pos ? undefined : 'hidden' }}
      className={cn(
        'fixed z-50 w-[calc(100%-16px)] @[20rem]:w-72 @[20rem]:max-w-[calc(100vw-16px)] -translate-y-full mb-1',
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

      {hasCaptures ? (
        <>
          <div className="h-px bg-surface-3 shrink-0" />
          <ContextSection label={t('agent.context.captures')}>
            {captures.map((c) => {
              const selected = selectedIds.has(c.id);
              const Icon =
                c.kind === 'console-error'
                  ? Bug
                  : c.kind === 'terminal-error'
                    ? SquareTerminal
                    : Code;
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
            })}
          </ContextSection>
        </>
      ) : null}

      {hasTabs ? (
        <>
          <div className="h-px bg-surface-3 shrink-0" />
          <ContextSection label={t('agent.context.openTabsFiles')}>
            {tabs.map((tab) => {
              const Icon = tabIcon(tab.kind);
              const mention = tabMention(tab);
              const display = tab.title || (tab.kind === 'editor' && tab.filePath) || tab.url || tab.kind;
              return (
                <TabRow
                  key={tab.id}
                  icon={<Icon size={12} />}
                  kind={tab.kind}
                  label={String(display)}
                  title={`${t('agent.context.insertMentionBefore')}${tab.kind}${t(
                    'agent.context.insertMentionAfter',
                  )}`}
                  onClick={() => {
                    onInsertMention(mention);
                    onClose();
                  }}
                />
              );
            })}
          </ContextSection>
        </>
      ) : null}
    </div>,
    document.body,
  );
}

