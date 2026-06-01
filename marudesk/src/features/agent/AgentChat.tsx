import { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  Brain,
  Send,
  Square,
  Loader2,
  Check,
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
  type LucideIcon,
} from 'lucide-react';
import { Badge, Button, DiffBlock } from '../../components/ui';
import { cn } from '../../lib/cn';
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
import { openSettingsTab } from '../settings/store';
import { useProvidersStore } from '../providers/store';
import { ProviderGlyph } from '../providers/ProviderGlyph';
import { useWorkspaceStore } from '../workspace/store';
import { useWebPageStore } from '../browser/store';
import { useAgentStore } from './store';
import { toDiffLines } from './diff';
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

  const summary = useWorkspaceStore((s) => s.summary);
  const statusChecked = useProvidersStore((s) => s.statusChecked);
  const refreshStatus = useProvidersStore((s) => s.refreshProviderStatus);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  const [contextOpen, setContextOpen] = useState(false);

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

  // Pin to the bottom as the transcript grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.status, chat.edits, chat.pendingApproval, chat.pendingQuestions]);

  const busy = isBusy(chat.status);
  const empty = chat.messages.length === 0;
  // The full-surface `agent` tab centers the conversation in a readable column
  // (Claude/Codex Desktop parity, v3 §5-B); the drawer companion stays compact.
  // Same single server-owned state projects into both.
  const full = variant === 'full';

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
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

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div
          className={cn(
            'flex flex-col gap-3',
            full ? 'mx-auto w-full max-w-3xl px-5 py-6' : 'px-3 py-3',
            empty && 'min-h-full justify-center',
          )}
        >
          {empty ? (
            <EmptyState hasWorkspace={!!summary} onPick={setDraft} />
          ) : (
            chat.messages.map((m, i) => (
              <MessageView
                key={m.id}
                message={m}
                streaming={chat.status === 'thinking' && i === chat.messages.length - 1}
              />
            ))
          )}

          {chat.edits.length > 0 ? <ChangesSection edits={chat.edits} /> : null}

          {chat.pendingApproval ? <ApprovalCard approval={chat.pendingApproval} /> : null}
          {chat.pendingQuestions ? <QuestionsCard pending={chat.pendingQuestions} /> : null}

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
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0">
              <StatusPill status={chat.status} />
              <UsageMeter />
            </div>
            <div className="flex items-center gap-1">
              {!busy && !empty ? (
                <button
                  type="button"
                  onClick={() => void resetChat()}
                  className="flex items-center gap-1 text-caption text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
                  title="Start a new conversation"
                >
                  <Eraser size={12} /> New chat
                </button>
              ) : null}
            </div>
          </div>

          {localError ? (
            <div className="rounded border border-subtle bg-error-subtle/40 px-3 py-1.5 text-caption text-fg-secondary break-words">
              {localError}
            </div>
          ) : null}

          <div className="flex items-end gap-2">
            <ContextButton
              buttonRef={plusButtonRef}
              open={contextOpen}
              onToggle={() => setContextOpen((v) => !v)}
            />
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={full ? 3 : 2}
              placeholder="Ask the agent to fix an error, change the UI, inspect the page… (Enter to send)"
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
                onClick={() => void send()}
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
          className="w-full h-8 px-2 rounded border border-default hover:border-accent flex items-center gap-2 text-body-sm text-fg-primary transition-colors duration-fast"
        >
          <ProviderGlyph
            provider={selectedProvider}
            label={providerLabel(selectedProvider, customProviders)}
            size={20}
          />
          <span className="truncate flex-1 text-left">{current?.label ?? selectedModel}</span>
          {current?.contextWindow ? (
            <span className="text-caption text-fg-tertiary tabular-nums shrink-0">
              {formatContext(current.contextWindow)}
            </span>
          ) : null}
          <span
            aria-hidden
            className={cn('size-1.5 rounded-pill shrink-0', hasKey ? 'bg-accent' : 'bg-fg-tertiary/40')}
          />
          <ChevronDown size={13} className="text-fg-tertiary shrink-0" />
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

function MessageView({ message, streaming }: { message: AgentMessage; streaming?: boolean }) {
  if (message.role === 'user') {
    return (
      <div className="self-end max-w-[92%] rounded-lg bg-accent-subtle/40 border border-subtle px-3 py-2">
        <p className="text-body-sm text-fg-primary whitespace-pre-wrap break-words">
          {textOf(message)}
        </p>
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
    <div className="flex flex-col gap-2">
      {message.parts.map((part, i) => {
        if (part.type === 'reasoning') {
          return <ThinkingBlock key={i} text={part.text} streaming={reasoningStreaming} />;
        }
        if (part.type === 'text') {
          const caret = streaming && i === lastTextIdx && !reasoningStreaming;
          if (!part.text.trim() && !caret) return null;
          return (
            <p key={i} className="text-body-sm text-fg-secondary whitespace-pre-wrap break-words leading-relaxed">
              {part.text}
              {caret ? <StreamCaret /> : null}
            </p>
          );
        }
        return <ToolCardView key={i} call={part.call} />;
      })}
    </div>
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
function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !!streaming;
  if (!text.trim() && !streaming) return null;
  return (
    <div className="rounded border border-subtle border-l-2 border-l-ai-thinking bg-surface-1 text-caption">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left"
      >
        {streaming ? (
          <Loader2 size={12} className="text-ai-thinking animate-spin shrink-0" />
        ) : (
          <Brain size={12} className="text-ai-thinking shrink-0" />
        )}
        <span className="text-fg-secondary flex-1">Thinking{streaming ? '…' : ''}</span>
        <ChevronRight
          size={12}
          className={cn('text-fg-tertiary shrink-0 transition-transform', open && 'rotate-90')}
        />
      </button>
      {open ? (
        <p className="px-2 pb-2 pt-0 text-caption text-fg-tertiary whitespace-pre-wrap break-words leading-relaxed">
          {text}
          {streaming ? <StreamCaret /> : null}
        </p>
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

function ToolCardView({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const meta = TOOL_META[call.name] ?? { label: call.name, icon: Wrench };
  const Icon = meta.icon;
  const badge =
    call.name === 'reload_and_verify'
      ? reloadVerdict(call.resultText)
      : call.name === 'get_console_errors'
        ? sourceConfidence(call.resultText)
        : null;
  // eval_js's summary is bare; surface the expression that ran (also visible
  // pre-approval) so the card shows what executed in the page.
  const expr = call.name === 'eval_js' ? stringField(call.input, 'expression') : '';
  const hasBody = !!call.resultText || !!expr;
  const running = call.state === 'running' || call.state === 'awaiting_approval';

  return (
    <div
      className={cn(
        'rounded border bg-surface-1 text-caption',
        meta.runtime ? 'border-subtle border-l-2 border-l-accent/50' : 'border-subtle',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left"
      >
        <ToolStateIcon state={call.state} />
        <Icon size={12} className={cn('shrink-0', meta.runtime ? 'text-accent' : 'text-fg-tertiary')} />
        <span className="text-fg-secondary truncate flex-1">{call.summary ?? meta.label}</span>
        {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null}
        {hasBody ? (
          <ChevronRight size={12} className={cn('text-fg-tertiary shrink-0 transition-transform', open && 'rotate-90')} />
        ) : null}
      </button>
      {open && hasBody ? (
        <div className="flex flex-col gap-1.5 px-2 pb-2 pt-0">
          {expr ? (
            <pre className="m-0 rounded bg-surface-page px-2 py-1.5 font-mono text-caption text-fg-secondary whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
              {expr}
            </pre>
          ) : null}
          {call.resultText ? (
            <pre className="m-0 font-mono text-caption text-fg-tertiary whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
              {call.resultText}
            </pre>
          ) : null}
        </div>
      ) : null}
      {running ? null : call.error ? (
        <div className="px-2 pb-1.5 text-error truncate" title={call.error}>
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
  return (
    <div className="flex flex-col gap-2">
      <div className="text-caption uppercase tracking-wider text-fg-tertiary">
        Changes ({edits.length})
      </div>
      {edits.map((e) => (
        <EditCard key={e.id} edit={e} />
      ))}
    </div>
  );
}

function EditCard({ edit }: { edit: AgentEdit }) {
  const [open, setOpen] = useState(false);
  const acceptEdit = useAgentStore((s) => s.acceptEdit);
  const revertEdit = useAgentStore((s) => s.revertEdit);
  const lines = open ? toDiffLines(edit.before, edit.after) : [];

  return (
    <div className="rounded border border-subtle bg-surface-1">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Badge variant={edit.kind === 'create' ? 'success' : 'neutral'}>{edit.kind}</Badge>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
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

function StatusPill({ status }: { status: AgentStatus }) {
  const busy = isBusy(status);
  return (
    <span className="flex items-center gap-1.5 text-caption text-fg-tertiary">
      {busy ? (
        <Loader2 size={11} className="animate-spin text-accent" />
      ) : (
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-pill',
            status === 'failed' ? 'bg-error' : status === 'completed' ? 'bg-accent' : 'bg-fg-tertiary',
          )}
        />
      )}
      {STATUS_LABEL[status]}
    </span>
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
    <div className="flex flex-col items-center text-center gap-3 px-4 text-fg-tertiary">
      <div className="flex size-10 items-center justify-center rounded-xl bg-accent-subtle ring-1 ring-accent/20">
        <Sparkles size={18} className="text-accent" />
      </div>
      <div className="flex flex-col items-center gap-1">
        <p className="text-body-sm text-fg-secondary">Agentic AI Chat</p>
        <p className="text-caption max-w-[260px]">
          {hasWorkspace
            ? 'Describe a change or a bug. The agent reads files, inspects the live page over CDP, edits, then reloads to verify — revert anything.'
            : 'Open a workspace, then ask the agent to fix a runtime error or change the UI.'}
        </p>
      </div>
      {hasWorkspace ? (
        <div className="flex w-full max-w-[280px] flex-col items-stretch gap-1.5 pt-1">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              className="rounded-lg border border-subtle bg-surface-1 px-3 py-1.5 text-left text-caption text-fg-secondary hover:border-accent/60 hover:bg-surface-2 hover:text-fg-primary transition-colors duration-fast"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
