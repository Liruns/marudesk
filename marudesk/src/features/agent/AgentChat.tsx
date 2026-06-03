import { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  Brain,
  Send,
  Square,
  Loader2,
  Check,
  Copy,
  X,
  Wrench,
  RotateCcw,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Search,
  Settings as SettingsIcon,
  Eraser,
  FileText,
  FolderTree,
  FilePen,
  Bug,
  Code,
  SquareTerminal,
  Network,
  RefreshCw,
  Plus,
  Globe,
  History,
  Database,
  Cookie,
  BookMarked,
  BookOpen,
  NotebookPen,
  LayoutGrid,
  FileCode,
  Trash2,
  ExternalLink,
  FolderOpen,
  ScrollText,
  TextQuote,
  List,
  ListTree,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  Hand,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Badge, Button, DiffBlock } from '../../components/ui';
import { cn } from '../../lib/cn';
import { Markdown } from '../../lib/markdown';
import { toast } from '../../lib/toast';
import { toMessage } from '../../lib/toMessage';
import {
  findModel,
  isBuiltinProviderId,
  providerLabel,
} from '../../../shared/providers';
import type {
  AgentChatState,
  AgentEdit,
  AgentMessage,
  AgentStatus,
  PendingApproval,
  PendingQuestions,
  ToolCall,
} from '../../../shared/agent';
import {
  filterSlash,
  resolveSlash,
  slashQuery,
  SLASH_COMMANDS,
  type SlashActionId,
  type SlashCommand,
} from '../../../shared/slash-commands';
import { openSettingsTab, useSettingsStore } from '../settings/store';
import { useProvidersStore } from '../providers/store';
import type { AgentApprovalMode, ReasoningEffort } from '../../../shared/settings';
import { ProviderGlyph } from '../providers/ProviderGlyph';
import { useWorkspaceStore } from '../workspace/store';
import { useWebPageStore } from '../browser/store';
import { useAgentStore, type TranscriptVerbosity } from './store';
import { toDiffLines, diffStats } from './diff';
import { ModelPalette } from './ModelPalette';
import { ContextPopover } from './ContextPopover';

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: 'Ready',
  thinking: 'Thinking…',
  working: 'Working…',
  waiting_for_user: 'Waiting for you',
  failed: 'Stopped',
  completed: 'Done',
};

/**
 * Hook: returns elapsed seconds (0 when not busy) for the active busy turn.
 * Resets to 0 each time `busy` flips true; ticks every second while busy.
 * Uses a ref-anchored start time so the interval callback computes elapsed
 * without needing a state setter in the effect body.
 */
function useElapsedTimer(busy: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!busy) {
      startRef.current = null;
      // Reset via interval-like mechanism to avoid inline setState in effect
      const id = setTimeout(() => setElapsed(0), 0);
      return () => clearTimeout(id);
    }
    startRef.current = Date.now();
    const id = setInterval(() => {
      if (startRef.current !== null) {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [busy]);

  return elapsed;
}

/** Format elapsed seconds as "0:05", "1:23", etc. */
function formatElapsed(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function isBusy(s: AgentStatus): boolean {
  return s === 'thinking' || s === 'working' || s === 'waiting_for_user';
}

export function AgentChat({ variant = 'drawer' }: { variant?: 'drawer' | 'full' } = {}) {
  const chat = useAgentStore((s) => s.chat);
  const draft = useAgentStore((s) => s.draft);
  const localError = useAgentStore((s) => s.localError);
  const setDraft = useAgentStore((s) => s.setDraft);
  const ingest = useAgentStore((s) => s.ingest);
  const hydrate = useAgentStore((s) => s.hydrate);
  const send = useAgentStore((s) => s.send);
  const abort = useAgentStore((s) => s.abort);
  const resetChat = useAgentStore((s) => s.resetChat);
  const verbosity = useAgentStore((s) => s.verbosity);
  const setVerbosity = useAgentStore((s) => s.setVerbosity);
  const approvalMode = useSettingsStore((s) => s.settings.agent.approvalMode);
  const reasoningEffort = useSettingsStore((s) => s.settings.agent.reasoningEffort);
  const updateSettings = useSettingsStore((s) => s.update);

  const summary = useWorkspaceStore((s) => s.summary);
  const statusChecked = useProvidersStore((s) => s.statusChecked);
  const refreshStatus = useProvidersStore((s) => s.refreshProviderStatus);
  // Reasoning-effort control is shown only for models the catalog flags `reasoning`.
  const models = useProvidersStore((s) => s.models);
  const selectedModelKey = useProvidersStore((s) => s.selectedModelKey);
  const isReasoningModel = !!findModel(models, selectedModelKey)?.reasoning;

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  const changesRef = useRef<HTMLDivElement>(null);
  const [contextOpen, setContextOpen] = useState(false);
  // Slash-command menu (`/` in the composer). `slashIndex` is the highlighted
  // row; `slashDismissed` lets Escape hide the menu without clearing the draft;
  // `slashInfo` shows the local `/help` or `/context` readout above the composer.
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashInfo, setSlashInfo] = useState<'help' | 'context' | null>(null);
  // Stick-to-bottom: true while the user is at/near the bottom (auto-scroll on),
  // false once they scroll up to re-read mid-stream (auto-scroll paused).
  const stickToBottomRef = useRef(true);

  // Subscribe to the server-owned snapshot stream while mounted; hydrate once so
  // we catch up on whatever happened while the panel was on another tab.
  useEffect(() => {
    void hydrate();
    const off = window.marudesk.on('agent:event', (s: AgentChatState) => ingest(s));
    return off;
  }, [hydrate, ingest]);

  useEffect(() => {
    if (!statusChecked) void refreshStatus();
  }, [statusChecked, refreshStatus]);

  // Pin to the bottom as the transcript grows — but only while the user is still
  // near the bottom. If they scroll up (e.g. to re-read mid-stream) we stop
  // yanking them down; scrolling back to the bottom re-arms it.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.status, chat.edits, chat.pendingApproval, chat.pendingQuestions, chat.endNote]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Threshold large enough to survive a streaming chunk landing between the
    // scroll event and the re-render, small enough that scrolling up clearly pauses.
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Auto-grow the composer to fit its content, up to the max height (max-h-40 =
  // 160px); taller drafts then scroll. Resetting to `auto` first re-derives the
  // baseline from the `rows` attribute, so the floor (2 rows drawer / 3 rows
  // full) is preserved and the box shrinks back when text is deleted. Runs on
  // every draft change so a multi-line paste expands instead of overflowing.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const busy = isBusy(chat.status);
  const elapsed = useElapsedTimer(busy);
  const empty = chat.messages.length === 0;
  // The full-surface `agent` tab centers the conversation in a readable column
  // (Claude/Codex Desktop parity, v3 §5-B); the drawer companion stays compact.
  // Same single server-owned state projects into both.
  const full = variant === 'full';
  // Completion receipt (Antigravity "Walkthrough" parity): a one-line outcome
  // shown when a finished turn actually probed the live app over CDP or ran a
  // verify pass — surfacing the runtime-evidence wedge + the verify verdict.
  const receipt =
    chat.status === 'completed' ? buildReceipt(chat.messages) : null;

  // Slash menu: visible while the draft is a bare `/token` (no argument yet) and
  // not dismissed. Once the user types a space (an argument), the menu hides and
  // the command runs on Enter via the resolver in handleSend.
  const slashQ = slashQuery(draft);
  const slashItems = slashQ !== null && !slashDismissed ? filterSlash(slashQ) : [];
  const slashOpen = slashItems.length > 0;

  const setDraftAndTrackSlash = (v: string) => {
    setDraft(v);
    setSlashDismissed(false);
    setSlashIndex(0);
    if (slashInfo) setSlashInfo(null);
  };

  const runSlashAction = (action: SlashActionId) => {
    switch (action) {
      case 'new':
        void resetChat();
        break;
      case 'diff':
        if (chat.edits.length > 0) {
          changesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          toast({ title: 'No changes yet', description: 'This conversation has not edited any files.' });
        }
        break;
      case 'context':
        setSlashInfo('context');
        break;
      case 'help':
        setSlashInfo('help');
        break;
      case 'model':
        window.dispatchEvent(new CustomEvent('marudesk:open-model-palette'));
        break;
    }
  };

  // Complete a picked menu command into the composer. Action commands run
  // immediately; prompt commands fill the line (`/review `) so the user can add
  // an argument, then Enter sends (handleSend expands it).
  const pickSlash = (cmd: SlashCommand) => {
    if (cmd.kind === 'action') {
      runSlashAction(cmd.action);
      setDraft('');
      setSlashDismissed(true);
      return;
    }
    const filled = `/${cmd.name} `;
    setDraft(filled);
    setSlashDismissed(true);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(filled.length, filled.length);
    });
  };

  const handleSend = () => {
    // A fresh prompt should snap back to the bottom even if the user scrolled up.
    stickToBottomRef.current = true;
    // Intercept slash commands before they reach the model. Action commands run
    // locally; prompt commands expand into a templated instruction and send.
    const resolved = resolveSlash(draft);
    if (resolved) {
      if (resolved.command.kind === 'action') {
        runSlashAction(resolved.command.action);
        setDraft('');
        return;
      }
      setDraft(resolved.command.expand(resolved.arg));
      void send();
      return;
    }
    void send();
  };

  // Picking an empty-state suggestion drops it into the composer and lands the
  // cursor there, so the user can tweak or just hit Enter without a second click.
  const handlePickSuggestion = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the slash menu is open it owns the arrow/Tab/Enter keys.
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const cmd = slashItems[Math.min(slashIndex, slashItems.length - 1)];
        if (cmd) pickSlash(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /**
   * Insert an @-mention at the current cursor position in the textarea. Falls
   * back to appending at the end if the element is not focused. After insertion
   * the textarea re-focuses so the user can keep typing.
   */
  const handleInsertMention = (mention: string) => {
    const el = textareaRef.current;
    if (!el) {
      setDraft(draft ? `${draft} ${mention} ` : `${mention} `);
      return;
    }
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    // Add a leading space if we're not at the beginning and the char before isn't whitespace.
    const spaceBefore = start > 0 && !/\s$/.test(before) ? ' ' : '';
    const newDraft = `${before}${spaceBefore}${mention} ${after}`;
    setDraft(newDraft);
    // Restore focus and position cursor after the mention.
    requestAnimationFrame(() => {
      el.focus();
      const cursor = start + spaceBefore.length + mention.length + 1;
      el.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <ProviderModelBar full={full} />

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-y-auto">
        <div
          className={cn(
            'flex flex-col gap-4',
            full ? 'mx-auto w-full max-w-3xl px-5 py-6' : 'px-3 py-4',
            empty && 'min-h-full justify-center',
          )}
        >
          {empty ? (
            <EmptyState hasWorkspace={!!summary} onPick={handlePickSuggestion} />
          ) : (
            chat.messages.map((m, i) => (
              <MessageView
                key={m.id}
                message={m}
                streaming={chat.status === 'thinking' && i === chat.messages.length - 1}
                verbosity={verbosity}
              />
            ))
          )}

          {chat.edits.length > 0 ? (
            <div ref={changesRef}>
              <ChangesSection edits={chat.edits} />
            </div>
          ) : null}

          {receipt ? <ReceiptCard receipt={receipt} /> : null}

          {chat.pendingApproval ? <ApprovalCard approval={chat.pendingApproval} /> : null}
          {chat.pendingQuestions ? <QuestionsCard pending={chat.pendingQuestions} /> : null}

          {chat.endNote ? (
            <div className="flex items-center justify-center gap-1.5 py-1 text-caption text-fg-tertiary">
              <Square size={11} className="shrink-0" />
              <span>{chat.endNote}</span>
            </div>
          ) : null}

          {chat.error ? (
            <div className="rounded border border-subtle bg-error-subtle/40 px-3 py-2 text-body-sm text-fg-secondary break-words">
              {chat.error}
            </div>
          ) : null}
        </div>
      </div>

      <footer className="shrink-0 border-t border-subtle">
        <div
          className={cn(
            'flex flex-col gap-2',
            full ? 'mx-auto w-full max-w-3xl px-5 py-3' : 'px-3 py-2',
          )}
        >
          {/* Status row: left = pill + usage; right = toggle cluster */}
          <div className="flex items-center justify-between gap-2 min-w-0">
            {/* Left: status + usage */}
            <div className="flex items-center gap-2.5 min-w-0 shrink-0">
              <StatusPill status={chat.status} elapsed={elapsed} />
              <UsageMeter />
            </div>

            {/* Right: toggles grouped in a single pill-shaped container */}
            <div className="flex items-center gap-px rounded border border-subtle bg-surface-1 p-0.5 shrink-0">
              {isReasoningModel ? (
                <>
                  <EffortToggle
                    value={reasoningEffort}
                    onChange={(effort) => void updateSettings({ agent: { reasoningEffort: effort } })}
                  />
                  {/* Divider */}
                  <span aria-hidden className="mx-0.5 h-3.5 w-px bg-surface-3" />
                </>
              ) : null}
              <ApprovalToggle
                value={approvalMode}
                onChange={(mode) => void updateSettings({ agent: { approvalMode: mode } })}
              />
              {!empty ? (
                <>
                  <span aria-hidden className="mx-0.5 h-3.5 w-px bg-surface-3" />
                  <VerbosityToggle value={verbosity} onChange={setVerbosity} />
                </>
              ) : null}
              {!busy && !empty ? (
                <>
                  <span aria-hidden className="mx-0.5 h-3.5 w-px bg-surface-3" />
                  <button
                    type="button"
                    onClick={() => void resetChat()}
                    className="flex items-center gap-1 h-5 px-1.5 rounded-sm text-caption text-fg-tertiary hover:text-fg-secondary hover:bg-surface-3 transition-colors duration-fast"
                    title="Start a new conversation"
                  >
                    <Eraser size={11} />
                    <span className="text-[10px] leading-none">New</span>
                  </button>
                </>
              ) : null}
            </div>
          </div>

          {localError ? (
            <div className="rounded border border-subtle bg-error-subtle/40 px-3 py-1.5 text-caption text-fg-secondary break-words">
              {localError}
            </div>
          ) : null}

          {slashInfo ? (
            <SlashInfoCard kind={slashInfo} onClose={() => setSlashInfo(null)} />
          ) : null}

          <div className="relative flex items-end gap-2">
            {slashOpen ? (
              <SlashMenu
                items={slashItems}
                activeIndex={Math.min(slashIndex, slashItems.length - 1)}
                onPick={pickSlash}
                onHover={setSlashIndex}
              />
            ) : null}
            <ContextButton
              buttonRef={plusButtonRef}
              open={contextOpen}
              onToggle={() => setContextOpen((v) => !v)}
            />
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraftAndTrackSlash(e.target.value)}
              onKeyDown={onKeyDown}
              rows={full ? 3 : 2}
              placeholder="Ask the agent, or type / for commands… (Enter to send)"
              spellCheck={false}
              className={cn(
                'flex-1 min-h-[44px] max-h-40 resize-none rounded bg-surface-page border border-default px-3 py-2',
                'font-mono text-body-sm text-fg-primary placeholder:text-fg-tertiary leading-relaxed',
                'focus:outline-none focus:border-accent',
              )}
              aria-label="Agent prompt"
            />
            {busy ? (
              <Button variant="secondary" size="md" leadingIcon={<Square size={14} />} onClick={() => void abort()}>
                Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                size="md"
                leadingIcon={<Send size={14} />}
                onClick={handleSend}
                disabled={draft.trim().length === 0}
              >
                Send
              </Button>
            )}
          </div>

          {contextOpen ? (
            <ContextPopover
              anchorRef={plusButtonRef}
              onClose={() => setContextOpen(false)}
              onInsertMention={handleInsertMention}
            />
          ) : null}
        </div>
      </footer>
    </div>
  );
}

/* ── slash command menu ─────────────────────────────────────────────────── */

/**
 * The `/` command menu (claude-code `/init` `/review`, codex `/diff` parity).
 * Floats above the composer while the draft is a bare `/token`. Arrow keys move
 * the selection, Enter/Tab pick, Escape dismisses — all driven from the
 * composer's onKeyDown so focus stays in the textarea.
 */
function SlashMenu({
  items,
  activeIndex,
  onPick,
  onHover,
}: {
  items: SlashCommand[];
  activeIndex: number;
  onPick: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-0 right-0 mb-2 z-20 max-h-64 overflow-y-auto rounded border border-default bg-surface-2 shadow-lifted py-1"
    >
      {items.map((cmd, i) => (
        <button
          key={cmd.name}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          onMouseEnter={() => onHover(i)}
          // Pick on mousedown so the textarea doesn't lose focus first (which
          // would tear down the menu before the click lands).
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(cmd);
          }}
          className={cn(
            'w-full flex items-baseline gap-2.5 px-3 py-1.5 text-left transition-colors duration-fast',
            i === activeIndex ? 'bg-surface-3' : 'hover:bg-surface-3/60',
          )}
        >
          <span className="font-mono text-body-sm text-fg-primary shrink-0">/{cmd.name}</span>
          {cmd.kind === 'prompt' && cmd.argHint ? (
            <span className="font-mono text-caption text-fg-tertiary shrink-0">{cmd.argHint}</span>
          ) : null}
          <span className="text-caption text-fg-tertiary truncate ml-auto pl-3">{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The local readout shown by `/help` (the command list) and `/context` (what is
 * currently in the model's context window). Neither makes a model call.
 */
function SlashInfoCard({ kind, onClose }: { kind: 'help' | 'context'; onClose: () => void }) {
  return (
    <div className="rounded border border-subtle bg-surface-1 px-3 py-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-caption font-medium text-fg-secondary">
          {kind === 'help' ? 'Slash commands' : 'Context window'}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
        >
          <X size={13} />
        </button>
      </div>
      {kind === 'help' ? <SlashHelpBody /> : <SlashContextBody />}
    </div>
  );
}

function SlashHelpBody() {
  return (
    <div className="flex flex-col gap-1">
      {SLASH_COMMANDS.map((cmd) => (
        <div key={cmd.name} className="flex items-baseline gap-2.5 text-body-sm">
          <span className="font-mono text-fg-primary shrink-0 w-20">/{cmd.name}</span>
          <span className="text-caption text-fg-tertiary">{cmd.description}</span>
        </div>
      ))}
    </div>
  );
}

function SlashContextBody() {
  const messages = useAgentStore((s) => s.chat.messages);
  const usage = useAgentStore((s) => s.chat.usage);
  const edits = useAgentStore((s) => s.chat.edits);
  const selectedModelKey = useProvidersStore((s) => s.selectedModelKey);
  const models = useProvidersStore((s) => s.models);
  const model = findModel(models, selectedModelKey);
  const ctx = model?.contextWindow;
  const pct = ctx ? Math.min(100, Math.round((usage.inputTokens / ctx) * 100)) : null;
  const rows: Array<[string, string]> = [
    ['Model', model ? model.label : '—'],
    ['Messages', String(messages.length)],
    ['Input tokens', usage.inputTokens.toLocaleString()],
    ['Output tokens', usage.outputTokens.toLocaleString()],
    ['Context window', ctx ? `${formatContext(ctx)} (${pct}% used)` : 'unknown'],
    ['Files edited', String(edits.length)],
  ];
  return (
    <div className="flex flex-col gap-1">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-3 text-body-sm">
          <span className="text-caption text-fg-tertiary">{label}</span>
          <span className="font-mono text-fg-primary tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}

/* ── "+" context button ─────────────────────────────────────────────────── */

/**
 * The "+" button that opens the context popover. Shows a count badge when any
 * captures are currently selected — so the user can glance at the composer and
 * know context is already attached before hitting Send.
 */
function ContextButton({
  buttonRef,
  open,
  onToggle,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  onToggle: () => void;
}) {
  const selectedIds = useWebPageStore((s) => s.selectedCaptureIds);
  const selectedCount = selectedIds.size;

  return (
    <div className="relative shrink-0 self-end mb-[3px]">
      <button
        ref={buttonRef}
        type="button"
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Add context"
        title="Add context (captures, tabs)"
        className={cn(
          'size-8 flex items-center justify-center rounded border transition-colors duration-fast',
          open
            ? 'border-accent bg-accent-subtle/30 text-accent'
            : 'border-default bg-surface-page text-fg-tertiary hover:border-accent/60 hover:text-fg-secondary',
        )}
      >
        <Plus size={14} />
      </button>
      {selectedCount > 0 ? (
        <span
          aria-label={`${selectedCount} capture${selectedCount === 1 ? '' : 's'} selected`}
          className={cn(
            'pointer-events-none absolute -top-1.5 -right-1.5',
            'flex items-center justify-center',
            'min-w-[16px] h-4 rounded-pill px-1',
            'bg-accent text-white text-[10px] font-medium tabular-nums leading-none',
          )}
        >
          {selectedCount}
        </span>
      ) : null}
    </div>
  );
}

/* ── provider / model bar (reuses the composer store) ───────────────────── */

/** Compact token-count label: 200000 → "200K", 1048576 → "1M". */
function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/**
 * Token usage for the running conversation against the selected model's context
 * window — the Claude/Codex Desktop-style usage readout. Hidden until a turn has
 * actually consumed tokens.
 */
function UsageMeter() {
  const usage = useAgentStore((s) => s.chat.usage);
  const selectedModelKey = useProvidersStore((s) => s.selectedModelKey);
  const models = useProvidersStore((s) => s.models);
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return null;
  const ctx = findModel(models, selectedModelKey)?.contextWindow;
  const pct = ctx ? Math.min(100, Math.round((usage.inputTokens / ctx) * 100)) : null;
  return (
    <span
      className="flex items-center gap-1.5 text-caption text-fg-tertiary tabular-nums shrink-0"
      title={`${usage.inputTokens.toLocaleString()} input · ${usage.outputTokens.toLocaleString()} output tokens`}
    >
      {pct !== null ? (
        <>
          <span aria-hidden className="h-1 w-8 rounded-pill bg-surface-3 overflow-hidden">
            <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
          </span>
          <span>{pct}%</span>
        </>
      ) : (
        <span>{formatContext(usage.inputTokens)} tok</span>
      )}
    </span>
  );
}

/**
 * Model selector trigger (docs/agentic-chat-v4-design.md §A1): a compact chip
 * showing the current model + context window + key status that opens the
 * command-palette {@link ModelPalette}. The inline "no key" banner nudges to
 * Settings when the active provider has no usable auth.
 */
function ProviderModelBar({ full }: { full?: boolean }) {
  const models = useProvidersStore((s) => s.models);
  const selectedModelKey = useProvidersStore((s) => s.selectedModelKey);
  const selectedModel = useProvidersStore((s) => s.selectedModel);
  const selectedProvider = useProvidersStore((s) => s.selectedProvider);
  const providerStatus = useProvidersStore((s) => s.providerStatus);
  const statusChecked = useProvidersStore((s) => s.statusChecked);
  const customProviders = useProvidersStore((s) => s.customProviders);
  const selectKeyProvider = useProvidersStore((s) => s.selectKeyProvider);

  const [open, setOpen] = useState(false);

  // The composer's `/model` command opens this palette via a window event, so the
  // command stays decoupled from the bar's local open state.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('marudesk:open-model-palette', onOpen);
    return () => window.removeEventListener('marudesk:open-model-palette', onOpen);
  }, []);

  const current = findModel(models, selectedModelKey);
  const hasKey = !!providerStatus.find((s) => s.id === selectedProvider)?.hasKey;

  return (
    <section className="shrink-0 px-3 py-2 border-b border-subtle">
      <div className={cn('relative', full && 'mx-auto w-full max-w-3xl')}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="w-full h-8 px-2.5 rounded border border-default hover:border-accent/70 bg-surface-page flex items-center gap-2 text-body-sm text-fg-primary transition-colors duration-fast group"
        >
          <ProviderGlyph
            provider={selectedProvider}
            label={providerLabel(selectedProvider, customProviders)}
            size={18}
          />
          <span className="truncate flex-1 text-left font-medium text-[0.8125rem]">{current?.label ?? selectedModel}</span>
          {current?.contextWindow ? (
            <span className="text-[0.6875rem] text-fg-tertiary/70 tabular-nums shrink-0 font-mono">
              {formatContext(current.contextWindow)}
            </span>
          ) : null}
          <span
            aria-hidden
            className={cn('size-1.5 rounded-pill shrink-0', hasKey ? 'bg-accent' : 'bg-fg-tertiary/30')}
          />
          <ChevronDown size={12} className="text-fg-tertiary/60 group-hover:text-fg-tertiary shrink-0 transition-colors duration-fast" />
        </button>

        {!hasKey && statusChecked && isBuiltinProviderId(selectedProvider) ? (
          <div className="mt-2 flex items-center justify-between gap-2 rounded border border-subtle bg-surface-2 px-2 py-1">
            <span className="text-caption text-fg-tertiary truncate">
              No API key for {providerLabel(selectedProvider, customProviders)}.
            </span>
            <button
              type="button"
              onClick={() => {
                selectKeyProvider(selectedProvider);
                void openSettingsTab('providers');
              }}
              className="flex items-center gap-1 text-caption text-fg-tertiary hover:text-accent transition-colors duration-fast"
            >
              <SettingsIcon size={12} /> Settings
            </button>
          </div>
        ) : null}
      </div>

      {open ? <ModelPalette onClose={() => setOpen(false)} /> : null}
    </section>
  );
}

/* ── messages ───────────────────────────────────────────────────────────── */

function MessageView({
  message,
  streaming,
  verbosity,
}: {
  message: AgentMessage;
  streaming?: boolean;
  verbosity: TranscriptVerbosity;
}) {
  if (message.role === 'user') {
    return (
      <div className="self-end max-w-[88%]">
        <div className="rounded-xl bg-accent-subtle/30 border border-accent/20 px-3.5 py-2.5 shadow-[0_1px_3px_rgba(0,0,0,0.15)]">
          <p className="text-body-sm text-fg-primary whitespace-pre-wrap break-words leading-relaxed">
            {textOf(message)}
          </p>
        </div>
      </div>
    );
  }
  // The streaming caret rides the last text part of the in-progress message
  // (which always exists — the loop seeds an empty text part per step).
  let lastTextIdx = -1;
  let answerText = '';
  message.parts.forEach((p, i) => {
    if (p.type === 'text') {
      lastTextIdx = i;
      answerText = p.text;
    }
  });
  const hasReasoning = message.parts.some((p) => p.type === 'reasoning');
  // While the model is still thinking (reasoning present, no answer text yet),
  // the Thinking block is the live edge — it auto-opens + holds the caret, and
  // we suppress the empty text part's caret so there's only one.
  const reasoningStreaming = streaming && hasReasoning && answerText.trim().length === 0;
  return (
    <div className="group/msg relative flex flex-col gap-2.5">
      {/* Copy the assistant's prose — appears on hover, hidden mid-stream. */}
      {!streaming && answerText.trim() ? (
        <div className="absolute -top-1 right-0 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-fast">
          <CopyButton text={answerText} label="Copy message" />
        </div>
      ) : null}
      {message.parts.map((part, i) => {
        if (part.type === 'reasoning') {
          // Summary hides intermediate reasoning; Verbose opens every Thinking
          // block; Normal keeps them collapsed.
          if (verbosity === 'summary') return null;
          return (
            <ThinkingBlock
              key={i}
              text={part.text}
              streaming={reasoningStreaming}
              defaultOpen={verbosity === 'verbose'}
            />
          );
        }
        if (part.type === 'text') {
          const caret = streaming && i === lastTextIdx && !reasoningStreaming;
          if (!part.text.trim() && !caret) return null;
          // Assistant answers are rendered as markdown (GFM + highlighted code
          // + copy buttons) via the shared renderer. The streaming caret rides
          // the live edge: it sits inline right after the rendered prose.
          return (
            <div key={i} className="text-body-sm text-fg-secondary">
              <Markdown source={part.text} className="md-compact" />
              {caret ? <StreamCaret /> : null}
            </div>
          );
        }
        // Tool cards: hidden in Summary, auto-expanded in Verbose.
        if (verbosity === 'summary') return null;
        return (
          <ToolCardView key={i} call={part.call} defaultOpen={verbosity === 'verbose'} />
        );
      })}
    </div>
  );
}

/** A small clipboard button with a brief "copied" check, used on messages and
 * tool output. */
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      toast({ title: 'Copy failed', description: toMessage(err), variant: 'error' });
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={label}
      aria-label={label}
      className="inline-flex size-5 items-center justify-center rounded text-fg-tertiary hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast"
    >
      {copied ? <Check size={12} className="text-accent" /> : <Copy size={12} />}
    </button>
  );
}

/** Blinking caret shown at the live edge of streaming assistant text (§6.3). */
function StreamCaret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[0.9em] w-[2px] translate-y-[1px] bg-accent animate-pulse"
    />
  );
}

/**
 * Collapsible "Thinking" block for the model's streamed reasoning (v3 §5-A —
 * Claude/Codex Desktop parity). It follows the live stream open while the model
 * is still thinking (no answer text yet), then respects the user's toggle once
 * clicked. Uses the peach `ai-thinking` timeline hue so reasoning reads visibly
 * distinct from the answer prose. Reasoning is display-only (never sent back to
 * the provider — see loop.ts), so this purely projects the streamed part.
 */
function ThinkingBlock({
  text,
  streaming,
  defaultOpen,
}: {
  text: string;
  streaming?: boolean;
  defaultOpen?: boolean;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? (!!streaming || !!defaultOpen);
  const thinkingElapsed = useElapsedTimer(!!streaming);
  if (!text.trim() && !streaming) return null;
  return (
    <div className="rounded border border-subtle border-l-2 border-l-ai-thinking bg-surface-1 text-caption">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {streaming ? (
          <Loader2 size={12} className="text-ai-thinking animate-spin shrink-0" />
        ) : (
          <Brain size={12} className="text-ai-thinking/70 shrink-0" />
        )}
        <span className="text-fg-secondary flex-1 font-medium">
          {streaming ? 'Thinking' : 'Thought'}
        </span>
        {streaming && thinkingElapsed > 0 ? (
          <span className="text-ai-thinking/80 tabular-nums text-[10px]">
            {formatElapsed(thinkingElapsed)}
          </span>
        ) : !streaming && text.trim() ? (
          <span className="text-fg-tertiary/60 text-[10px]">
            {Math.ceil(text.length / 200)}s
          </span>
        ) : null}
        <ChevronRight
          size={11}
          className={cn('text-fg-tertiary/60 shrink-0 transition-transform duration-fast', open && 'rotate-90')}
        />
      </button>
      {open ? (
        <div className="px-2.5 pb-2 pt-0 border-t border-subtle/60">
          <p className="mt-1.5 text-caption text-fg-tertiary/80 whitespace-pre-wrap break-words leading-relaxed">
            {text}
            {streaming ? <StreamCaret /> : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function textOf(message: AgentMessage): string {
  return message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

type ToolMeta = { label: string; icon: LucideIcon; runtime?: boolean };

/**
 * Per-tool presentation. `runtime` tools read/act on the LIVE running page over
 * CDP — marudesk's differentiator ([[marudesk-positioning-wedge]]). They get an
 * accent spine + accent icon so the transcript visibly shows the agent inspecting
 * the running app, not just the source.
 */
const TOOL_META: Record<string, ToolMeta> = {
  read_file: { label: 'Read', icon: FileText },
  list_files: { label: 'List files', icon: FolderTree },
  grep: { label: 'Search', icon: Search },
  edit_file: { label: 'Edit', icon: FilePen },
  multi_edit: { label: 'Multi-edit', icon: FilePen },
  get_console_errors: { label: 'Console errors', icon: Bug, runtime: true },
  read_console: { label: 'Console output', icon: ScrollText, runtime: true },
  query_dom: { label: 'Query DOM', icon: Code, runtime: true },
  eval_js: { label: 'Eval JS', icon: SquareTerminal, runtime: true },
  read_network: { label: 'Network', icon: Network, runtime: true },
  read_network_body: { label: 'Response body', icon: Network, runtime: true },
  reload_and_verify: { label: 'Reload & verify', icon: RefreshCw, runtime: true },
  // Context MCP — reads of the live app (runtime spine) vs. stored state.
  browser_cookies: { label: 'Cookies', icon: Cookie, runtime: true },
  browser_storage: { label: 'Web storage', icon: Database, runtime: true },
  list_tabs: { label: 'List tabs', icon: LayoutGrid, runtime: true },
  read_page: { label: 'Read page', icon: Globe, runtime: true },
  list_terminals: { label: 'List terminals', icon: SquareTerminal, runtime: true },
  read_terminal: { label: 'Read terminal', icon: SquareTerminal, runtime: true },
  read_editor: { label: 'Read editor', icon: FileCode },
  read_explorer: { label: 'Explorer state', icon: FolderTree },
  list_sessions: { label: 'List sessions', icon: History },
  read_session: { label: 'Read session', icon: History },
  delete_session: { label: 'Delete session', icon: Trash2 },
  list_memory: { label: 'List memory', icon: BookMarked },
  read_memory: { label: 'Read memory', icon: BookOpen },
  write_memory: { label: 'Write memory', icon: NotebookPen },
  delete_memory: { label: 'Delete memory', icon: Trash2 },
  // PC control (acts on the computer, outside the workspace).
  open_path: { label: 'Open file/folder', icon: FolderOpen, runtime: true },
  open_external: { label: 'Open URL', icon: ExternalLink, runtime: true },
  reveal_in_explorer: { label: 'Reveal in file manager', icon: FolderTree, runtime: true },
};

/** reload_and_verify's verdict, parsed from the server-formatted result — the
 * closed-loop highlight: did the fix actually clear the runtime error? */
function reloadVerdict(text?: string): { variant: 'success' | 'warning'; label: string } | null {
  if (!text) return null;
  if (/^GONE\b/.test(text) || text.includes('No console errors after reload')) {
    return { variant: 'success', label: 'errors gone' };
  }
  if (/^STILL PRESENT\b/.test(text)) return { variant: 'warning', label: 'still present' };
  return null;
}

/** get_console_errors P1 confidence: did the stack map to a workspace file? */
function sourceConfidence(text?: string): { variant: 'accent' | 'neutral'; label: string } | null {
  if (!text) return null;
  if (text.includes('confidence: high')) return { variant: 'accent', label: 'source mapped' };
  if (text.includes('confidence: low')) return { variant: 'neutral', label: 'no source' };
  return null;
}

function stringField(input: unknown, key: string): string {
  const v = input as Record<string, unknown> | null;
  return v && typeof v[key] === 'string' ? (v[key] as string) : '';
}

/**
 * Map a tool name to the AI-timeline hue token for its left-border accent.
 * Four categories (matching tokens.css --ai-thinking/grep/read/edit):
 *   thinking  → planning / reasoning tools
 *   grep      → search / list tools
 *   read      → read / query / observe tools
 *   edit      → write / mutate / runtime-act tools
 */
function toolTimelineHue(name: string): 'thinking' | 'grep' | 'read' | 'edit' | null {
  if (!name) return null;
  // grep / search / list
  if (['grep', 'list_files', 'list_tabs', 'list_terminals', 'list_sessions', 'list_memory'].includes(name))
    return 'grep';
  // read / observe / query
  if ([
    'read_file', 'read_console', 'query_dom', 'read_network', 'read_network_body',
    'read_page', 'read_terminal', 'read_editor', 'read_explorer', 'read_session',
    'read_memory', 'browser_cookies', 'browser_storage', 'get_console_errors',
  ].includes(name))
    return 'read';
  // edit / mutate / act
  if ([
    'edit_file', 'multi_edit', 'eval_js', 'reload_and_verify', 'open_path',
    'open_external', 'reveal_in_explorer', 'write_memory', 'delete_memory',
    'delete_session',
  ].includes(name))
    return 'edit';
  return null;
}

const TIMELINE_BORDER: Record<'thinking' | 'grep' | 'read' | 'edit', string> = {
  thinking: 'border-l-ai-thinking',
  grep:     'border-l-ai-grep',
  read:     'border-l-ai-read',
  edit:     'border-l-ai-edit',
};

const TIMELINE_ICON: Record<'thinking' | 'grep' | 'read' | 'edit', string> = {
  thinking: 'text-ai-thinking',
  grep:     'text-ai-grep',
  read:     'text-ai-read',
  edit:     'text-ai-edit',
};

function ToolCardView({ call, defaultOpen }: { call: ToolCall; defaultOpen?: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !!defaultOpen;
  const meta = TOOL_META[call.name] ?? { label: call.name, icon: Wrench };
  const Icon = meta.icon;
  const badge =
    call.name === 'reload_and_verify'
      ? reloadVerdict(call.resultText)
      : call.name === 'get_console_errors'
        ? sourceConfidence(call.resultText)
        : null;
  const expr = call.name === 'eval_js' ? stringField(call.input, 'expression') : '';
  const hasBody = !!call.resultText || !!expr;
  const running = call.state === 'running' || call.state === 'awaiting_approval';
  const hue = toolTimelineHue(call.name);

  return (
    <div
      className={cn(
        'rounded border border-subtle bg-surface-1 text-caption',
        // Left accent spine: AI timeline hue if categorised; accent tint for runtime; plain for others
        hue
          ? cn('border-l-2', TIMELINE_BORDER[hue])
          : meta.runtime
            ? 'border-l-2 border-l-accent/40'
            : '',
      )}
    >
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <ToolStateIcon state={call.state} />
        <Icon
          size={12}
          className={cn(
            'shrink-0',
            hue ? TIMELINE_ICON[hue] : meta.runtime ? 'text-accent' : 'text-fg-tertiary',
          )}
        />
        <span className="text-fg-secondary truncate flex-1 text-[0.75rem]">{call.summary ?? meta.label}</span>
        {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null}
        {hasBody ? (
          <ChevronRight size={11} className={cn('text-fg-tertiary/60 shrink-0 transition-transform duration-fast', open && 'rotate-90')} />
        ) : null}
      </button>
      {open && hasBody ? (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2 pt-0 border-t border-subtle/60">
          {expr ? (
            <pre className="m-0 mt-1.5 rounded bg-surface-page px-2 py-1.5 font-mono text-caption text-fg-secondary whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
              {expr}
            </pre>
          ) : null}
          {call.resultText ? (
            <div className="group/out relative">
              <div className="absolute top-1 right-1 opacity-0 group-hover/out:opacity-100 transition-opacity duration-fast">
                <CopyButton text={call.resultText} label="Copy output" />
              </div>
              <pre className="m-0 mt-1 font-mono text-caption text-fg-tertiary whitespace-pre-wrap break-words max-h-60 overflow-y-auto leading-relaxed">
                {call.resultText}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
      {running ? null : call.error ? (
        <div className="px-2.5 pb-1.5 text-error text-caption truncate border-t border-subtle/60" title={call.error}>
          {call.error}
        </div>
      ) : null}
    </div>
  );
}

function ToolStateIcon({ state }: { state: ToolCall['state'] }) {
  if (state === 'running') return <Loader2 size={12} className="text-accent animate-spin shrink-0" />;
  if (state === 'awaiting_approval') return <AlertCircle size={12} className="text-warning shrink-0" />;
  if (state === 'ok') return <Check size={12} className="text-accent shrink-0" />;
  if (state === 'denied' || state === 'aborted') return <X size={12} className="text-fg-tertiary shrink-0" />;
  if (state === 'error') return <AlertCircle size={12} className="text-error shrink-0" />;
  return <Wrench size={12} className="text-fg-tertiary shrink-0" />;
}

/* ── edits (P2: accept / revert) ────────────────────────────────────────── */

function ChangesSection({ edits }: { edits: AgentEdit[] }) {
  const acceptEdit = useAgentStore((s) => s.acceptEdit);
  const revertEdit = useAgentStore((s) => s.revertEdit);
  // Which file diffs are expanded. "Expand all" fills it; per-file toggles flip
  // a single id. Kept here (not per card) so the bulk control can drive them.
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());

  const totals = edits.reduce(
    (acc, e) => {
      const { added, removed } = diffStats(e.before, e.after);
      acc.added += added;
      acc.removed += removed;
      return acc;
    },
    { added: 0, removed: 0 },
  );
  const applied = edits.filter((e) => e.status === 'applied');
  const allOpen = edits.length > 0 && openIds.size === edits.length;

  const toggleOne = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setOpenIds(allOpen ? new Set() : new Set(edits.map((e) => e.id)));

  return (
    <div className="flex flex-col gap-2">
      {/* Aggregate review header: file count + total +/- across the turn, with
          bulk keep/revert and expand-all (Zed / Codex multi-file review parity). */}
      <div className="flex items-center gap-2 text-caption">
        <span className="uppercase tracking-wider text-fg-tertiary">
          {edits.length} file{edits.length === 1 ? '' : 's'} changed
        </span>
        <span className="tabular-nums text-success">+{totals.added}</span>
        <span className="tabular-nums text-error">−{totals.removed}</span>
        <span className="flex-1" aria-hidden />
        {applied.length > 0 ? (
          <>
            <button
              type="button"
              onClick={() => applied.forEach((e) => void acceptEdit(e.id))}
              className="flex items-center gap-1 text-fg-tertiary hover:text-accent transition-colors"
              title="Keep all changes"
            >
              <Check size={12} /> Keep all
            </button>
            <button
              type="button"
              onClick={() => applied.forEach((e) => void revertEdit(e.id))}
              className="flex items-center gap-1 text-fg-tertiary hover:text-error transition-colors"
              title="Revert all changes on disk"
            >
              <RotateCcw size={12} /> Revert all
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={toggleAll}
          aria-label={allOpen ? 'Collapse all diffs' : 'Expand all diffs'}
          title={allOpen ? 'Collapse all diffs' : 'Expand all diffs'}
          className="text-fg-tertiary hover:text-fg-secondary transition-colors"
        >
          {allOpen ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
        </button>
      </div>
      {edits.map((e) => (
        <EditCard
          key={e.id}
          edit={e}
          open={openIds.has(e.id)}
          onToggle={() => toggleOne(e.id)}
        />
      ))}
    </div>
  );
}

function EditCard({
  edit,
  open,
  onToggle,
}: {
  edit: AgentEdit;
  open: boolean;
  onToggle: () => void;
}) {
  const acceptEdit = useAgentStore((s) => s.acceptEdit);
  const revertEdit = useAgentStore((s) => s.revertEdit);
  const lines = open ? toDiffLines(edit.before, edit.after) : [];

  return (
    <div className="rounded border border-subtle bg-surface-1">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Badge variant={edit.kind === 'create' ? 'success' : 'neutral'}>{edit.kind}</Badge>
        <button
          type="button"
          onClick={onToggle}
          className="font-mono text-caption text-fg-secondary truncate flex-1 text-left hover:text-fg-primary"
          title={edit.path}
        >
          {edit.path}
        </button>
        {edit.status === 'applied' ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void acceptEdit(edit.id)}
              className="flex items-center gap-1 text-caption text-fg-tertiary hover:text-accent transition-colors"
              title="Keep this change"
            >
              <Check size={12} /> Keep
            </button>
            <button
              type="button"
              onClick={() => void revertEdit(edit.id)}
              className="flex items-center gap-1 text-caption text-fg-tertiary hover:text-error transition-colors"
              title="Revert this change on disk"
            >
              <RotateCcw size={12} /> Revert
            </button>
          </div>
        ) : (
          <Badge variant={edit.status === 'reverted' ? 'warning' : 'success'}>
            {edit.status === 'reverted' ? 'reverted' : 'kept'}
          </Badge>
        )}
      </div>
      {open ? <DiffBlock filePath={edit.path} lines={lines} className="rounded-none border-0 border-t border-subtle" /> : null}
    </div>
  );
}

/* ── completion receipt (Antigravity "Walkthrough" parity) ──────────────── */

type Receipt = {
  runtime: number;
  verdict: { variant: 'success' | 'warning'; label: string } | null;
};

/**
 * Derive a runtime-verified outcome from a finished turn: how many CDP checks
 * touched the live app, plus the last reload-and-verify verdict. Returns null
 * unless the agent actually probed the running app or ran a verify pass — pure
 * edits are covered by the Changes review, and plain Q&A needs no receipt.
 */
function buildReceipt(messages: AgentMessage[]): Receipt | null {
  let runtime = 0;
  let verdict: Receipt['verdict'] = null;
  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type !== 'tool') continue;
      if (TOOL_META[part.call.name]?.runtime) runtime++;
      if (part.call.name === 'reload_and_verify') {
        const v = reloadVerdict(part.call.resultText);
        if (v) verdict = v;
      }
    }
  }
  if (runtime === 0 && !verdict) return null;
  return { runtime, verdict };
}

function ReceiptCard({ receipt }: { receipt: Receipt }) {
  return (
    <div className="rounded-lg border border-subtle bg-surface-1 p-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="flex items-center gap-2 text-body-sm text-fg-primary">
        <span className="flex size-5 items-center justify-center rounded-pill bg-success-subtle shrink-0">
          <Check size={12} className="text-success" />
        </span>
        <span className="font-medium">Done</span>
      </span>
      {receipt.verdict ? (
        <Badge variant={receipt.verdict.variant}>{receipt.verdict.label}</Badge>
      ) : null}
      {receipt.runtime > 0 ? (
        <span className="flex items-center gap-1 text-caption text-fg-tertiary tabular-nums">
          <span className="size-1.5 rounded-pill bg-accent shrink-0" aria-hidden />
          {receipt.runtime} runtime check{receipt.runtime === 1 ? '' : 's'} on the live app
        </span>
      ) : null}
    </div>
  );
}

/* ── approval / questions (parked turns) ────────────────────────────────── */

function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const approve = useAgentStore((s) => s.approve);
  return (
    <div className="rounded border border-warning/40 bg-warning-subtle/30 p-2 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-body-sm text-fg-primary">
        <AlertCircle size={14} className="text-warning" />
        Approve <span className="font-mono">{approval.name}</span>?
      </div>
      <pre className="m-0 font-mono text-caption text-fg-secondary whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded bg-surface-page px-2 py-1.5">
        {approval.detail}
      </pre>
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => void approve(approval.callId, true)}>
          Approve
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void approve(approval.callId, false)}>
          Deny
        </Button>
      </div>
    </div>
  );
}

function QuestionsCard({ pending }: { pending: PendingQuestions }) {
  const answer = useAgentStore((s) => s.answer);
  const [values, setValues] = useState<Record<string, string>>({});

  const submit = () => void answer(pending.callId, values);

  return (
    <div className="rounded border border-accent/40 bg-accent-subtle/20 p-2 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-body-sm text-fg-primary">
        <Sparkles size={14} className="text-accent" /> The agent needs your input
      </div>
      {pending.questions.map((q) => (
        <div key={q.id} className="flex flex-col gap-1">
          <span className="text-body-sm text-fg-secondary">{q.question}</span>
          {q.options && q.options.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {q.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setValues((v) => ({ ...v, [q.id]: opt }))}
                  className={cn(
                    'h-6 px-2 rounded border text-caption transition-colors',
                    values[q.id] === opt
                      ? 'border-accent text-fg-primary bg-accent-subtle/40'
                      : 'border-subtle text-fg-tertiary hover:text-fg-secondary',
                  )}
                >
                  {opt}
                </button>
              ))}
            </div>
          ) : null}
          <input
            value={values[q.id] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [q.id]: e.target.value }))}
            placeholder="Type your answer…"
            className="h-7 rounded bg-surface-page border border-default px-2 text-body-sm text-fg-primary focus:outline-none focus:border-accent"
          />
        </div>
      ))}
      <Button variant="primary" size="sm" onClick={submit}>
        Send answer
      </Button>
    </div>
  );
}

/* ── misc ───────────────────────────────────────────────────────────────── */

function StatusPill({ status, elapsed = 0 }: { status: AgentStatus; elapsed?: number }) {
  const busy = isBusy(status);
  return (
    <span className="flex items-center gap-1.5 text-caption text-fg-tertiary tabular-nums">
      {busy ? (
        <Loader2 size={11} className="animate-spin text-accent shrink-0" />
      ) : (
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-pill shrink-0',
            status === 'failed' ? 'bg-error' : status === 'completed' ? 'bg-accent' : 'bg-fg-tertiary/50',
          )}
        />
      )}
      {/* Announce only the label (not the per-second elapsed tick) so screen
          readers hear the turn lifecycle — Thinking → Working → Done — once. */}
      <span aria-live="polite">{STATUS_LABEL[status]}</span>
      {busy && elapsed > 0 ? (
        <span className="text-fg-tertiary/70">{formatElapsed(elapsed)}</span>
      ) : null}
    </span>
  );
}

const VERBOSITY_OPTS: { value: TranscriptVerbosity; icon: LucideIcon; label: string }[] = [
  { value: 'summary', icon: TextQuote, label: 'Summary — answers only' },
  { value: 'normal', icon: List, label: 'Normal — steps collapsed' },
  { value: 'verbose', icon: ListTree, label: 'Verbose — expand every step' },
];

/**
 * Transcript detail dial (Claude Desktop parity). Summary shows only the agent's
 * prose answers; Normal keeps tool/thinking steps collapsed; Verbose expands them.
 * A compact 3-way segmented control sitting in the composer footer.
 */
function VerbosityToggle({
  value,
  onChange,
}: {
  value: TranscriptVerbosity;
  onChange: (v: TranscriptVerbosity) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Transcript detail"
      className="flex items-center gap-0.5"
    >
      {VERBOSITY_OPTS.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            title={opt.label}
            className={cn(
              'flex items-center justify-center size-5 rounded-sm transition-colors duration-fast',
              active
                ? 'bg-surface-3 text-fg-primary'
                : 'text-fg-tertiary hover:text-fg-secondary',
            )}
          >
            <Icon size={12} />
          </button>
        );
      })}
    </div>
  );
}

const APPROVAL_OPTS: { value: AgentApprovalMode; icon: LucideIcon; label: string }[] = [
  { value: 'plan', icon: NotebookPen, label: 'Plan — research only, then propose a step-by-step plan' },
  { value: 'read-only', icon: Eye, label: 'Read-only — observe only (no edits, no code)' },
  { value: 'ask', icon: Hand, label: 'Ask — edits run; sensitive tools ask first' },
  { value: 'auto', icon: Zap, label: 'Auto — run everything without asking' },
];

/**
 * Inline approval-mode toggle (v3 §5-D) — the same three modes as Settings →
 * Agent, surfaced beside the composer so autonomy can be dialed without leaving
 * the chat. Writes straight to the persisted setting; the loop reads it per turn.
 */
function ApprovalToggle({
  value,
  onChange,
}: {
  value: AgentApprovalMode;
  onChange: (v: AgentApprovalMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Approval mode"
      className="flex items-center gap-0.5"
    >
      {APPROVAL_OPTS.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            title={opt.label}
            className={cn(
              'flex items-center justify-center size-5 rounded-sm transition-colors duration-fast',
              active
                ? 'bg-surface-3 text-fg-primary'
                : 'text-fg-tertiary hover:text-fg-secondary',
            )}
          >
            <Icon size={12} />
          </button>
        );
      })}
    </div>
  );
}

const EFFORT_OPTS: { value: ReasoningEffort; short: string; label: string }[] = [
  { value: 'minimal', short: 'Min', label: 'Minimal — fastest, barely thinks' },
  { value: 'low', short: 'Low', label: 'Low — quick, light reasoning' },
  { value: 'medium', short: 'Med', label: 'Medium — balanced reasoning (default)' },
  { value: 'high', short: 'High', label: 'High — deepest, slowest reasoning' },
];

/**
 * Inline reasoning-effort dial — shown only when the selected model is a
 * reasoning model. Mirrors {@link ApprovalToggle}: writes the persisted
 * `agent.reasoningEffort`, which the loop maps to each provider's native thinking
 * knob per turn. A leading Brain icon marks the group; the four levels use short
 * text labels (vs. the icon-only Approval/Verbosity groups) so they stay legible.
 */
function EffortToggle({
  value,
  onChange,
}: {
  value: ReasoningEffort;
  onChange: (v: ReasoningEffort) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Reasoning effort"
      className="flex items-center gap-0.5"
    >
      <Brain size={11} className="mx-0.5 text-fg-tertiary/60 shrink-0" aria-hidden />
      {EFFORT_OPTS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            title={opt.label}
            className={cn(
              'flex items-center justify-center h-5 px-1 rounded-sm text-[10px] font-medium leading-none transition-colors duration-fast',
              active
                ? 'bg-surface-3 text-fg-primary'
                : 'text-fg-tertiary hover:text-fg-secondary',
            )}
          >
            {opt.short}
          </button>
        );
      })}
    </div>
  );
}

const SUGGESTIONS = [
  'Fix the console error on this page',
  'Why is this network request failing?',
  'Change this component’s layout',
];

function EmptyState({
  hasWorkspace,
  onPick,
}: {
  hasWorkspace: boolean;
  onPick: (text: string) => void;
}) {
  return (
    <div className="flex flex-col items-center text-center gap-4 px-4 py-2">
      {/* Icon mark */}
      <div className="flex size-12 items-center justify-center rounded-2xl bg-accent-subtle/60 ring-1 ring-accent/25 shadow-[0_0_0_4px_rgba(94,106,210,0.06)]">
        <Sparkles size={20} className="text-accent" />
      </div>

      <div className="flex flex-col items-center gap-1.5">
        <p className="text-body-sm font-medium text-fg-primary tracking-tight">Agentic AI Chat</p>
        <p className="text-caption text-fg-tertiary max-w-[264px] leading-relaxed">
          {hasWorkspace
            ? 'Describe a change or bug. The agent reads files, inspects the live page over CDP, edits, then reloads to verify — revert anything.'
            : 'Open a workspace, then ask the agent to fix a runtime error or change the UI.'}
        </p>
      </div>

      {hasWorkspace ? (
        <div className="flex w-full max-w-[288px] flex-col items-stretch gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              className={cn(
                'group rounded-lg border border-subtle bg-surface-1 px-3 py-2 text-left',
                'text-caption text-fg-secondary',
                'hover:border-accent/50 hover:bg-surface-2 hover:text-fg-primary',
                'transition-colors duration-fast',
                'flex items-center gap-2',
              )}
            >
              <span className="flex-1">{s}</span>
              <ChevronRight size={11} className="text-fg-tertiary/40 group-hover:text-fg-tertiary transition-colors duration-fast shrink-0" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
