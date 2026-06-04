import { useState } from 'react';
import { Brain, ChevronDown, ChevronRight, Layers } from 'lucide-react';
import type { AgentMessage, AgentPart } from '../types';
import { ToolCallCard } from './ToolCallCard';

export function MessageBubble({ message, streaming }: { message: AgentMessage; streaming?: boolean }) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    return (
      <div className="message-row message-row--user">
        <div className="message-bubble message-bubble--user">{text}</div>
      </div>
    );
  }

  return (
    <div className="message-row message-row--assistant">
      {message.parts.map((part, i) => (
        <Part key={i} part={part} last={i === message.parts.length - 1} streaming={streaming} />
      ))}
    </div>
  );
}

function Part({ part, last, streaming }: { part: AgentPart; last: boolean; streaming?: boolean }) {
  if (part.type === 'reasoning') return <ReasoningBlock text={part.text} />;
  if (part.type === 'tool') return <ToolCallCard call={part.call} />;
  if (part.type === 'compaction') return <CompactionDivider summary={part.summary} />;
  return (
    <div className="message-text">
      {part.text}
      {streaming && last && <span className="caret">|</span>}
    </div>
  );
}

function CompactionDivider({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="compaction-divider">
      <button className="reasoning-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Layers size={14} />
        Earlier turns compacted
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && <div className="reasoning-content">{summary}</div>}
    </div>
  );
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning-block">
      <button className="reasoning-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Brain size={14} />
        Thinking
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && <div className="reasoning-content">{text}</div>}
    </div>
  );
}
