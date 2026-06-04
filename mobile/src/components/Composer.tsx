import { useState } from 'react';
import { Send, Square } from 'lucide-react';

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
    <div className="composer-shell">
      <div className="composer-row">
        <textarea
          className="composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? 'Connect to your PC' : 'Message the agent'}
          disabled={disabled}
          rows={1}
        />
        {busy ? (
          <button onClick={onStop} className="composer-button composer-button--stop" aria-label="Stop">
            <Square size={18} fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!canSend}
            className="composer-button composer-button--send"
            aria-label="Send"
          >
            <Send size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
