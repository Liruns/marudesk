import { AlertTriangle, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import type { TransportStatusInfo } from '../../transport';

export function EmptyState({ connected }: { readonly connected: boolean }) {
  return (
    <div className="chat-empty">
      <div className="chat-empty__glyph">
        <Sparkles size={30} />
      </div>
      <div className="chat-empty__title">Ask your PC agent</div>
      <p className="chat-empty__copy">
        {connected
          ? 'Desktop is online. Send the next task when ready.'
          : 'Bring the PC online, then start from this phone.'}
      </p>
    </div>
  );
}

export function ThinkingRow() {
  return (
    <div className="thinking-row">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="thinking-row__dot"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
      <span>Thinking</span>
    </div>
  );
}

export function CommandErrorBanner({
  message,
  onDismiss,
}: {
  readonly message: string;
  readonly onDismiss: () => void;
}) {
  return (
    <div className="command-error" role="alert">
      <AlertTriangle size={16} />
      <span>{message}</span>
      <button className="command-error__dismiss" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

export function ConnectionBanner({
  status,
  onReconnect,
}: {
  readonly status: TransportStatusInfo['status'];
  readonly onReconnect: () => void;
}) {
  const connecting = status === 'connecting';

  return (
    <div className="connection-banner">
      {connecting ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
      <span>{connecting ? 'Connecting to your PC' : 'Not connected to your PC'}</span>
      {!connecting && (
        <button className="connection-banner__retry" onClick={onReconnect}>
          Retry
        </button>
      )}
    </div>
  );
}
