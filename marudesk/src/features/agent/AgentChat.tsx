import { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  Send,
  Square,
  Loader2,
  Check,
  X,
  Wrench,
  RotateCcw,
  AlertCircle,
  ChevronRight,
  Settings as SettingsIcon,
  Eraser,
} from 'lucide-react';
import { Badge, Button, DiffBlock } from '../../components/ui';
import { cn } from '../../lib/cn';
import { PROVIDERS } from '../../../shared/providers';
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
import { useComposerStore } from '../composer/store';
import { useWorkspaceStore } from '../workspace/store';
import { useAgentStore } from './store';
import { toDiffLines } from './diff';

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

export function AgentChat() {
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
  const statusChecked = useComposerStore((s) => s.statusChecked);
  const refreshStatus = useComposerStore((s) => s.refreshProviderStatus);

  const scrollRef = useRef<HTMLDivElement>(null);

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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <ProviderModelBar />

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {empty ? (
          <EmptyState hasWorkspace={!!summary} />
        ) : (
          chat.messages.map((m) => <MessageView key={m.id} message={m} />)
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

      <footer className="shrink-0 border-t border-subtle px-3 py-2 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <StatusPill status={chat.status} />
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
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
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
      </footer>
    </div>
  );
}

/* ── provider / model bar (reuses the composer store) ───────────────────── */

function ProviderModelBar() {
  const selectedProvider = useComposerStore((s) => s.selectedProvider);
  const selectedModel = useComposerStore((s) => s.selectedModel);
  const setSelectedProvider = useComposerStore((s) => s.setSelectedProvider);
  const setSelectedModel = useComposerStore((s) => s.setSelectedModel);
  const providerStatus = useComposerStore((s) => s.providerStatus);
  const statusChecked = useComposerStore((s) => s.statusChecked);
  const modelsByProvider = useComposerStore((s) => s.modelsByProvider);
  const selectKeyProvider = useComposerStore((s) => s.selectKeyProvider);

  const hasKey = !!providerStatus.find((s) => s.id === selectedProvider)?.hasKey;
  const models = modelsByProvider[selectedProvider] ?? [];

  return (
    <section className="shrink-0 px-3 py-2 border-b border-subtle flex flex-col gap-2">
      <div className="flex items-center gap-1">
        {PROVIDERS.map((p) => {
          const active = p.id === selectedProvider;
          const filled = !!providerStatus.find((s) => s.id === p.id)?.hasKey;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedProvider(p.id)}
              aria-pressed={active}
              className={cn(
                'h-6 px-2 rounded border text-caption flex items-center gap-1 transition-colors duration-fast',
                active
                  ? 'border-accent text-fg-primary bg-accent-subtle/30'
                  : 'border-subtle text-fg-tertiary hover:text-fg-secondary',
              )}
            >
              <span>{p.label}</span>
              {filled ? <span aria-hidden className="size-1.5 rounded-pill bg-accent" /> : null}
            </button>
          );
        })}
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          disabled={models.length === 0}
          className="ml-auto h-6 max-w-[48%] rounded bg-surface-page border border-default px-1.5 text-caption text-fg-primary focus:outline-none focus:border-accent disabled:opacity-50"
        >
          {models.some((m) => m.id === selectedModel) ? null : (
            <option value={selectedModel}>{selectedModel}</option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {!hasKey && statusChecked ? (
        <div className="flex items-center justify-between gap-2 rounded border border-subtle bg-surface-2 px-2 py-1">
          <span className="text-caption text-fg-tertiary truncate">
            No API key for {PROVIDERS.find((p) => p.id === selectedProvider)?.label}.
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
    </section>
  );
}

/* ── messages ───────────────────────────────────────────────────────────── */

function MessageView({ message }: { message: AgentMessage }) {
  if (message.role === 'user') {
    return (
      <div className="self-end max-w-[92%] rounded-lg bg-accent-subtle/40 border border-subtle px-3 py-2">
        <p className="text-body-sm text-fg-primary whitespace-pre-wrap break-words">
          {textOf(message)}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {message.parts.map((part, i) =>
        part.type === 'text' ? (
          part.text.trim() ? (
            <p key={i} className="text-body-sm text-fg-secondary whitespace-pre-wrap break-words leading-relaxed">
              {part.text}
            </p>
          ) : null
        ) : (
          <ToolCardView key={i} call={part.call} />
        ),
      )}
    </div>
  );
}

function textOf(message: AgentMessage): string {
  return message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

function ToolCardView({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const running = call.state === 'running' || call.state === 'awaiting_approval';
  return (
    <div className="rounded border border-subtle bg-surface-1 text-caption">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left"
      >
        <ToolStateIcon state={call.state} />
        <span className="font-mono text-fg-secondary">{call.name}</span>
        <span className="text-fg-tertiary truncate flex-1">{call.summary ?? ''}</span>
        {call.resultText ? (
          <ChevronRight size={12} className={cn('text-fg-tertiary transition-transform', open && 'rotate-90')} />
        ) : null}
      </button>
      {open && call.resultText ? (
        <pre className="px-2 pb-2 pt-0 m-0 font-mono text-caption text-fg-tertiary whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
          {call.resultText}
        </pre>
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

function EmptyState({ hasWorkspace }: { hasWorkspace: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 py-10 px-4 text-fg-tertiary">
      <Sparkles size={20} className="text-accent" />
      <p className="text-body-sm text-fg-secondary">Agentic AI Chat</p>
      <p className="text-caption max-w-[260px]">
        {hasWorkspace
          ? 'Describe a change or a bug. The agent reads files, inspects the live page over CDP, edits, then reloads to verify — and you can revert anything.'
          : 'Open a workspace, then ask the agent to fix a runtime error or change the UI.'}
      </p>
    </div>
  );
}
