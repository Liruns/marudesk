import { memo, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  Brain,
  ChevronDown,
  ChevronRight,
  Layers,
  Loader2,
  Wrench,
  X,
} from 'lucide-react';
import { Badge, CopyButton } from '../../../components/ui';
import { useElapsedTimer, formatElapsed } from '../../../hooks';
import { useI18n } from '../../../i18n/useI18n';
import { cn } from '../../../lib/cn';
import { Markdown } from '../../../lib/markdown';
import type { AgentMessage, ToolCall } from '../../../../shared/agent';
import type { TranscriptVerbosity } from '../store';
import {
  formatContext,
  reloadVerdict,
  sourceConfidence,
  stringField,
  textOf,
  toolTimelineHue,
  TOOL_META,
} from './format';
import { ChatImage, MediaGallery } from './Media';
import { ArtifactView } from './Artifact';

/* ── messages ───────────────────────────────────────────────────────────── */

/**
 * The `/compact` boundary marker in the transcript. Everything above it stays
 * visible; this divider tells the user the model's working memory of those turns
 * was condensed into a summary (claude-code / cursor parity — compaction trims
 * the context window, not the user's scrollback). Click to expand the summary
 * the model now carries forward.
 */
function CompactionDivider({ summary, freedTokens }: { summary: string; freedTokens?: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const label = freedTokens
    ? t('agent.chat.compaction.labelFreed').replace('{tokens}', formatContext(freedTokens))
    : t('agent.chat.compaction.label');
  return (
    <div className="flex flex-col gap-2 py-1">
      <div className="flex items-center gap-2 text-caption text-fg-tertiary">
        <span className="h-px flex-1 bg-subtle" />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 shrink-0 hover:text-fg-secondary transition-colors duration-fast"
          aria-expanded={open}
        >
          <Layers size={11} className="shrink-0" />
          <span>{label}</span>
          {open ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
        </button>
        <span className="h-px flex-1 bg-subtle" />
      </div>
      {open ? (
        <div className="rounded border border-subtle bg-surface-2/50 px-3 py-2 text-body-sm text-fg-secondary">
          <Markdown source={summary} className="md-compact" />
        </div>
      ) : null}
    </div>
  );
}

export const MessageView = memo(function MessageView({
  message,
  streaming,
  verbosity,
}: {
  message: AgentMessage;
  streaming?: boolean;
  verbosity: TranscriptVerbosity;
}) {
  const { t } = useI18n();
  // A `/compact` boundary: render as a centered divider instead of a bubble so
  // the scrollback above it stays readable while signalling that the model's
  // memory of those turns is now the (expandable) summary.
  const compaction = message.parts.find((p) => p.type === 'compaction');
  if (compaction) {
    return <CompactionDivider summary={compaction.summary} freedTokens={compaction.freedTokens} />;
  }
  if (message.role === 'user') {
    const images = message.parts.filter((p) => p.type === 'image');
    return (
      <div id={`agent-msg-${message.id}`} className="self-end max-w-[88%]">
        <div className="rounded-xl bg-surface-3 border border-strong/40 shadow-card px-3.5 py-2.5">
          <p className="text-body-sm text-fg-primary whitespace-pre-wrap break-words leading-relaxed">
            {textOf(message)}
          </p>
          {images.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {images.map((img, i) => (
                <ChatImage key={`${img.mediaType}:${img.data.length}:${i}`} mediaType={img.mediaType} data={img.data} />
              ))}
            </div>
          ) : null}
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
  const verbose = verbosity === 'verbose';

  // Assemble the visible blocks, merging consecutive tool calls into one
  // segmented card: a multi-step turn reads as a single activity timeline
  // instead of a stack of separate bordered cards. Parts that render nothing
  // (step-seeded empty text, hidden reasoning, update_plan) don't split a run.
  const blocks: ReactNode[] = [];
  let toolRun: { call: ToolCall; key: string }[] = [];
  const flushToolRun = () => {
    if (toolRun.length === 0) return;
    const cards = toolRun;
    toolRun = [];
    if (cards.length === 1) {
      blocks.push(<ToolCardView key={cards[0].key} call={cards[0].call} defaultOpen={verbose} />);
      return;
    }
    blocks.push(
      <div
        key={cards[0].key}
        className="rounded-lg overflow-hidden border border-subtle/80 bg-surface-1/70 shadow-card divide-y divide-subtle"
      >
        {cards.map((c) => (
          <ToolCardView key={c.key} call={c.call} defaultOpen={verbose} grouped />
        ))}
      </div>,
    );
  };

  message.parts.forEach((part, i) => {
    const key = `p${i}`;
    if (part.type === 'reasoning') {
      // Summary hides intermediate reasoning; Verbose opens every Thinking
      // block; Normal keeps them collapsed.
      if (verbosity === 'summary') return;
      flushToolRun();
      blocks.push(
        <ThinkingBlock key={key} text={part.text} streaming={reasoningStreaming} defaultOpen={verbose} />,
      );
      return;
    }
    if (part.type === 'text') {
      const caret = streaming && i === lastTextIdx && !reasoningStreaming;
      if (!part.text.trim() && !caret) return;
      flushToolRun();
      // Assistant answers are rendered as markdown (GFM + highlighted code
      // + copy buttons) via the shared renderer. The streaming caret rides
      // the live edge: it sits inline right after the rendered prose.
      blocks.push(
        <div key={key} className="min-w-0 max-w-full text-body-sm text-fg-secondary">
          <Markdown source={part.text} className="md-compact" />
          {caret ? <StreamCaret /> : null}
        </div>,
      );
      return;
    }
    if (part.type === 'image') {
      flushToolRun();
      blocks.push(
        <div key={key}>
          <ChatImage mediaType={part.mediaType} data={part.data} />
        </div>,
      );
      return;
    }
    // Compaction dividers are handled by the early return above; nothing
    // else renders them inline.
    if (part.type !== 'tool') return;
    // The plan tool's state lives in the Taskboard (a dedicated surface), so
    // don't also render a redundant tool card per update_plan call.
    if (part.call.name === 'update_plan') return;
    const media = part.call.media;
    const artifact = part.call.artifact;
    if (media?.length || artifact) {
      // Generated media and interactive artifacts render inline regardless of
      // verbosity (the result, not just a tool card / file path) — this call
      // stands alone so the result sits right under its card.
      flushToolRun();
      blocks.push(
        <div key={key} className="flex flex-col gap-2">
          {verbosity === 'summary' ? null : <ToolCardView call={part.call} defaultOpen={verbose} />}
          {media?.length ? <MediaGallery media={media} /> : null}
          {artifact ? <ArtifactView artifact={artifact} /> : null}
        </div>,
      );
      return;
    }
    // Tool cards: hidden in Summary, auto-expanded in Verbose.
    if (verbosity === 'summary') return;
    toolRun.push({ call: part.call, key });
  });
  flushToolRun();

  return (
    <div id={`agent-msg-${message.id}`} className="group/msg relative flex min-w-0 flex-col gap-2">
      {/* Copy the assistant's prose — appears on hover, hidden mid-stream. */}
      {!streaming && answerText.trim() ? (
        <div className="absolute -top-1 right-0 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-fast">
          <CopyButton text={answerText} label={t('agent.chat.copyMessage')} />
        </div>
      ) : null}
      {blocks}
    </div>
  );
});

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
  const { t } = useI18n();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? (!!streaming || !!defaultOpen);
  const thinkingElapsed = useElapsedTimer(!!streaming);
  if (!text.trim() && !streaming) return null;
  return (
    <div className="rounded-lg overflow-hidden border border-subtle/80 border-l-2 border-l-ai-thinking bg-surface-1/60 text-caption shadow-card">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-2/40 transition-colors duration-fast"
      >
        {streaming ? (
          <Loader2 size={12} className="text-ai-thinking animate-spin shrink-0" />
        ) : (
          <Brain size={12} className="text-ai-thinking/60 shrink-0" />
        )}
        <span className="text-fg-secondary flex-1 font-medium text-[0.75rem]">
          {streaming ? t('agent.chat.thinking') : t('agent.chat.thought')}
        </span>
        {streaming && thinkingElapsed > 0 ? (
          <span className="text-ai-thinking/70 tabular-nums text-[10px] font-medium">
            {formatElapsed(thinkingElapsed)}
          </span>
        ) : null}
        <ChevronRight
          size={11}
          className={cn('text-fg-tertiary/40 shrink-0 transition-transform duration-fast', open && 'rotate-90')}
        />
      </button>
      {open ? (
        <div className="px-3 pb-2.5 pt-0 border-t border-subtle/50">
          <p className="mt-2 text-caption text-fg-tertiary/70 whitespace-pre-wrap break-words leading-relaxed">
            {text}
            {streaming ? <StreamCaret /> : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* ── tool cards ─────────────────────────────────────────────────────────── */

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

const ToolCardView = memo(function ToolCardView({
  call,
  defaultOpen,
  grouped,
}: {
  call: ToolCall;
  defaultOpen?: boolean;
  /** Rendered as a row inside a merged tool-run card: the wrapper owns the
   * border/background/shadow, the row keeps only its hue spine. */
  grouped?: boolean;
}) {
  const { t } = useI18n();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const meta = TOOL_META[call.name];
  const Icon = meta?.icon ?? Wrench;
  const label = meta ? t(meta.labelKey) : call.name;
  const badge =
    call.name === 'reload_and_verify'
      ? reloadVerdict(call.resultText)
      : call.name === 'get_console_errors'
        ? sourceConfidence(call.resultText)
        : null;
  const expr = call.name === 'eval_js' ? stringField(call.input, 'expression') : '';
  // W4/U3: a running child tool streams partial text + a tool trace onto its card.
  const hasLive = !!call.streamedText || (call.streamedTraces?.length ?? 0) > 0;
  const hasBody = !!call.resultText || !!expr || hasLive;
  // Auto-expand while the live stream is flowing so progress is visible, until the
  // user manually toggles the card.
  const open = userOpen ?? (!!defaultOpen || hasLive);
  const running = call.state === 'running' || call.state === 'awaiting_approval';
  const hue = toolTimelineHue(call.name);

  return (
    <div
      className={cn(
        'overflow-hidden text-caption',
        grouped ? '' : 'rounded-lg border border-subtle/80 bg-surface-1/70 shadow-card',
        // Left accent spine: AI timeline hue if categorised; accent tint for
        // runtime; transparent inside a group so the rows stay aligned.
        hue
          ? cn('border-l-2', TIMELINE_BORDER[hue])
          : meta?.runtime
            ? 'border-l-2 border-l-accent/40'
            : grouped
              ? 'border-l-2 border-l-transparent'
              : '',
      )}
    >
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-2/40 transition-colors duration-fast"
      >
        {/* One icon slot: the tool glyph by default; the state icon takes over
            only while the call needs attention (running / approval / failure).
            Quiet success — no per-row checkmark noise. */}
        {call.state === 'ok' ? (
          <Icon
            size={12}
            className={cn(
              'shrink-0',
              hue ? TIMELINE_ICON[hue] : meta?.runtime ? 'text-accent' : 'text-fg-tertiary/70',
            )}
          />
        ) : (
          <ToolStateIcon state={call.state} />
        )}
        <span className="text-fg-secondary truncate flex-1 text-[0.75rem]">{call.summary ?? label}</span>
        {badge ? <Badge variant={badge.variant}>{t(badge.labelKey)}</Badge> : null}
        {hasBody ? (
          <ChevronRight size={11} className={cn('text-fg-tertiary/40 shrink-0 transition-transform duration-fast', open && 'rotate-90')} />
        ) : null}
      </button>
      {open && hasBody ? (
        <div className="flex flex-col gap-1.5 px-3 pb-2.5 pt-0 border-t border-subtle/50">
          {expr ? (
            <pre className="m-0 mt-2 rounded-md bg-surface-page px-2.5 py-2 font-mono text-caption text-fg-secondary whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
              {expr}
            </pre>
          ) : null}
          {hasLive ? (
            <div className="mt-2 flex flex-col gap-1">
              {call.streamedText ? (
                <pre className="m-0 font-mono text-caption text-fg-tertiary/80 whitespace-pre-wrap break-words max-h-40 overflow-y-auto leading-relaxed">
                  {call.streamedText}
                </pre>
              ) : null}
              {call.streamedTraces && call.streamedTraces.length > 0 ? (
                <ul className="m-0 list-none p-0 flex flex-col gap-0.5">
                  {call.streamedTraces.map((trace, i) => (
                    <li key={i} className="text-fg-tertiary/60 truncate font-mono text-caption">
                      · {trace}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {call.resultText ? (
            <div className="group/out relative">
              <div className="absolute top-1.5 right-1.5 opacity-0 group-hover/out:opacity-100 transition-opacity duration-fast">
                <CopyButton text={call.resultText} label={t('agent.chat.copyOutput')} />
              </div>
              <pre className="m-0 mt-1.5 font-mono text-caption text-fg-tertiary/70 whitespace-pre-wrap break-words max-h-60 overflow-y-auto leading-relaxed">
                {call.resultText}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
      {running ? null : call.error ? (
        <div className="px-3 pb-2 text-error text-caption truncate border-t border-subtle/50" title={call.error}>
          {call.error}
        </div>
      ) : null}
    </div>
  );
});

/** Attention-state icon for a tool row. `ok` never reaches here — a finished
 * call shows its tool glyph instead (see the icon slot in ToolCardView). */
function ToolStateIcon({ state }: { state: ToolCall['state'] }) {
  if (state === 'running') return <Loader2 size={12} className="text-accent animate-spin shrink-0" />;
  if (state === 'awaiting_approval') return <AlertCircle size={12} className="text-warning shrink-0" />;
  if (state === 'denied' || state === 'aborted') return <X size={12} className="text-fg-tertiary shrink-0" />;
  if (state === 'error') return <AlertCircle size={12} className="text-error shrink-0" />;
  return <Wrench size={12} className="text-fg-tertiary shrink-0" />;
}
