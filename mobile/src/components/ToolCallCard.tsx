import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, Wrench, X, Circle } from 'lucide-react';
import type { ToolCall, ToolCallState } from '../types';

const STATE_META: Record<ToolCallState, { label: string; color: string }> = {
  awaiting_approval: { label: 'Needs approval', color: 'var(--warn)' },
  running: { label: 'Running', color: 'var(--accent)' },
  ok: { label: 'Done', color: 'var(--ok)' },
  error: { label: 'Error', color: 'var(--danger)' },
  denied: { label: 'Denied', color: 'var(--fg-faint)' },
  aborted: { label: 'Aborted', color: 'var(--fg-faint)' },
};

function StateIcon({ state }: { state: ToolCallState }) {
  const color = STATE_META[state].color;
  if (state === 'running') return <Loader2 size={15} className="spin" style={{ color }} />;
  if (state === 'ok') return <Check size={15} style={{ color }} />;
  if (state === 'error' || state === 'denied' || state === 'aborted')
    return <X size={15} style={{ color }} />;
  return <Circle size={15} style={{ color }} />;
}

/**
 * A model-requested tool call rendered as a collapsible card. Header = icon +
 * summary/name + state chip; expanding reveals the input and the (scrubbed)
 * result text. Touch target on the whole header row.
 */
export function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const meta = STATE_META[call.state];
  const hasBody = Boolean(call.resultText || call.error || call.input !== undefined);

  return (
    <div className="tool-card">
      <button
        className="tool-card__header"
        onClick={() => hasBody && setOpen((v) => !v)}
      >
        <Wrench size={16} className="tool-card__icon" />
        <span className="tool-card__name">
          {call.summary || call.name}
        </span>
        <span className="tool-card__state" style={{ color: meta.color }}>
          <StateIcon state={call.state} />
          {meta.label}
        </span>
        {hasBody &&
          (open ? (
            <ChevronDown size={16} style={{ color: 'var(--fg-faint)' }} />
          ) : (
            <ChevronRight size={16} style={{ color: 'var(--fg-faint)' }} />
          ))}
      </button>

      {open && hasBody && (
        <div className="tool-card__body">
          {call.input !== undefined && (
            <Block label="Input" body={formatInput(call.input)} />
          )}
          {call.resultText && <Block label="Result" body={call.resultText} />}
          {call.error && <Block label="Error" body={call.error} danger />}
        </div>
      )}
    </div>
  );
}

function Block({ label, body, danger = false }: { label: string; body: string; danger?: boolean }) {
  return (
    <div className="tool-block">
      <div className="tool-block__label">{label}</div>
      <pre
        className={danger ? 'tool-block__code tool-block__code--danger' : 'tool-block__code'}
      >
        {body}
      </pre>
    </div>
  );
}

function formatInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
