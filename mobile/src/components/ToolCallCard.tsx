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
    <div
      className="card"
      style={{ background: 'var(--bg-elev-2)', overflow: 'hidden', margin: '8px 0' }}
    >
      <button
        onClick={() => hasBody && setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          padding: '12px 14px',
          minHeight: 'var(--tap)',
          textAlign: 'left',
        }}
      >
        <Wrench size={16} style={{ color: 'var(--fg-muted)', flexShrink: 0 }} />
        <span
          style={{
            flex: 1,
            fontSize: 14,
            fontWeight: 600,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {call.summary || call.name}
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 12,
            fontWeight: 600,
            color: meta.color,
            flexShrink: 0,
          }}
        >
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
        <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
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
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-faint)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <pre
        style={{
          margin: 0,
          padding: 10,
          background: 'var(--bg)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border)',
          fontSize: 12.5,
          lineHeight: 1.45,
          color: danger ? 'var(--danger)' : 'var(--fg)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 240,
          overflowY: 'auto',
        }}
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
