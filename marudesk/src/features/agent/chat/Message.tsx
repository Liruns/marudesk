import { memo, useState } from 'react';
import {
  AlertCircle,
  Brain,
  Check,
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
import type { AgentMessage, AgentStatus, ToolCall } from '../../../../shared/agent';
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

/**
 * The transcript body. Memoised on `(messages, status, verbosity)` so an
 * unrelated re-render of the composer (every keystroke writes the draft to the
 * store) doesn't re-run the whole map — only a new turn, a status change, or a
 * verbosity flip rebuilds the list. Each row is itself memoised by message id,
 * so streaming only re-renders the live message.
 */
export const MessageList = memo(function MessageList({
  messages,
  status,
  verbosity,
}: {
  messages: AgentMessage[];
  status: AgentStatus;
  verbosity: TranscriptVerbosity;
}) {
  return (
    <>
      {messages.map((m, i) => (
        <MessageView
          key={m.id}
          message={m}
          streaming={status === 'thinking' && i === messages.length - 1}
          verbosity={verbosity}
        />
      ))}
    </>
  );
});

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
      <div className="self-end max-w-[88%]">
        <div className="rounded-lg bg-accent-subtle/30 border border-accent/20 px-3.5 py-2.5">
          <p className="text-body-sm text-fg-primary whitespace-pre-wrap break-words leading-relaxed">
            {textOf(message)}
          </p>
          {images.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {images.map((img, i) => (
                <ChatImage key={i} mediaType={img.mediaType} data={img.data} />
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
  return (
    <div className="group/msg relative flex flex-col gap-2.5">
      {/* Copy the assistant's prose — appears on hover, hidden mid-stream. */}
      {!streaming && answerText.trim() ? (
        <div className="absolute -top-1 right-0 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-fast">
          <CopyButton text={answerText} label={t('agent.chat.copyMessage')} />
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
        if (part.type === 'image') {
          return (
            <div key={i}>
              <ChatImage mediaType={part.mediaType} data={part.data} />
            </div>
          );
        }
        // Compaction dividers are handled by the early return above; nothing
        // else renders them inline.
        if (part.type !== 'tool') return null;
        // The plan tool's state lives in the Taskboard (a dedicated surface), so
        // don't also render a redundant tool card per update_plan call.
        if (part.call.name === 'update_plan') return null;
        // Tool cards: hidden in Summary, auto-expanded in Verbose. Generated
        // media (images/videos) renders inline regardless of verbosity so a
        // "make me an image" turn always shows the result, not just a file path.
        const media = part.call.media;
        const card =
          verbosity === 'summary' ? null : (
            <ToolCardView call={part.call} defaultOpen={verbosity === 'verbose'} />
          );
        if (!media?.length) return card ? <div key={i}>{card}</div> : null;
        return (
          <div key={i} className="flex flex-col gap-2">
            {card}
            <MediaGallery media={media} />
          </div>
        );
      })}
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
          {streaming ? t('agent.chat.thinking') : t('agent.chat.thought')}
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
}: {
  call: ToolCall;
  defaultOpen?: boolean;
}) {
  const { t } = useI18n();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !!defaultOpen;
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
          : meta?.runtime
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
            hue ? TIMELINE_ICON[hue] : meta?.runtime ? 'text-accent' : 'text-fg-tertiary',
          )}
        />
        <span className="text-fg-secondary truncate flex-1 text-[0.75rem]">{call.summary ?? label}</span>
        {badge ? <Badge variant={badge.variant}>{t(badge.labelKey)}</Badge> : null}
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
                <CopyButton text={call.resultText} label={t('agent.chat.copyOutput')} />
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
});

function ToolStateIcon({ state }: { state: ToolCall['state'] }) {
  if (state === 'running') return <Loader2 size={12} className="text-accent animate-spin shrink-0" />;
  if (state === 'awaiting_approval') return <AlertCircle size={12} className="text-warning shrink-0" />;
  if (state === 'ok') return <Check size={12} className="text-accent shrink-0" />;
  if (state === 'denied' || state === 'aborted') return <X size={12} className="text-fg-tertiary shrink-0" />;
  if (state === 'error') return <AlertCircle size={12} className="text-error shrink-0" />;
  return <Wrench size={12} className="text-fg-tertiary shrink-0" />;
}
