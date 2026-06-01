import { useState } from 'react';
import { Send, Square } from 'lucide-react';

/**
 * Bottom-anchored message composer. Auto-grows up to a few lines, keeps its
 * bottom padding clear of the home indicator via env(safe-area-inset-bottom),
 * and swaps the send button for a stop button while the agent is busy.
 */
export function Composer({
  busy,
  disabled,
  onSend,
  onStop,
}: {
  busy: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const canSend = text.trim().length > 0 && !disabled;

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText('');
  };

  return (
    <div
      style={{
        flexShrink: 0,
        padding: '10px 12px calc(var(--safe-bottom) + 10px)',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-elev)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends on a hardware/desktop keyboard; Shift+Enter = newline.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? 'Connect to your PC to chat…' : 'Message the agent…'}
          disabled={disabled}
          rows={1}
          style={{
            flex: 1,
            resize: 'none',
            maxHeight: 132,
            minHeight: 'var(--tap)',
            padding: '12px 14px',
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            outline: 'none',
            fontSize: 15,
            lineHeight: 1.4,
          }}
        />
        {busy ? (
          <button
            onClick={onStop}
            className="btn"
            aria-label="Stop"
            style={{ width: 'var(--tap)', height: 'var(--tap)', padding: 0, borderRadius: '50%', background: 'var(--danger-soft)', color: 'var(--danger)', flexShrink: 0 }}
          >
            <Square size={18} fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!canSend}
            className="btn btn-primary"
            aria-label="Send"
            style={{ width: 'var(--tap)', height: 'var(--tap)', padding: 0, borderRadius: '50%', flexShrink: 0 }}
          >
            <Send size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
