import { useState } from 'react';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import type { AgentMessage, AgentPart } from '../types';
import { ToolCallCard } from './ToolCallCard';

/**
 * One chat message. User messages are a right-aligned accent bubble; assistant
 * messages render their ordered parts inline (reasoning block → text → tool
 * cards) with no bubble chrome so tool cards and long answers breathe.
 */
export function MessageBubble({ message, streaming }: { message: AgentMessage; streaming?: boolean }) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 14px' }}>
        <div
          style={{
            maxWidth: '82%',
            padding: '10px 14px',
            borderRadius: '18px 18px 4px 18px',
            background: 'var(--accent)',
            color: 'var(--on-accent)',
            fontSize: 15,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {text}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '6px 14px', display: 'flex', flexDirection: 'column' }}>
      {message.parts.map((part, i) => (
        <Part key={i} part={part} last={i === message.parts.length - 1} streaming={streaming} />
      ))}
    </div>
  );
}

function Part({ part, last, streaming }: { part: AgentPart; last: boolean; streaming?: boolean }) {
  if (part.type === 'reasoning') return <ReasoningBlock text={part.text} />;
  if (part.type === 'tool') return <ToolCallCard call={part.call} />;
  return (
    <div style={{ fontSize: 15, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--fg)' }}>
      {part.text}
      {streaming && last && <span className="caret">▋</span>}
    </div>
  );
}

/** Collapsible "Thinking" block (Claude/Codex-Desktop parity). Collapsed by default. */
function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: '2px 0 8px' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--thinking)',
          padding: '4px 0',
          minHeight: 32,
        }}
      >
        <Brain size={14} />
        Thinking
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <div
          style={{
            marginTop: 4,
            paddingLeft: 12,
            borderLeft: '2px solid var(--border-strong)',
            fontSize: 13.5,
            lineHeight: 1.5,
            color: 'var(--fg-muted)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}
