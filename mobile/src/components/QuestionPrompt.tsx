import { useState } from 'react';
import { CircleHelp, Send } from 'lucide-react';
import type { PendingQuestions } from '../types';

/**
 * Inline `ask_user` prompt. Renders each question with its suggested options as
 * big tappable chips plus a free-text field; submitting sends an answers map
 * keyed by question id. Anchored above the composer.
 */
export function QuestionPrompt({
  pending,
  busy,
  onSubmit,
}: {
  pending: PendingQuestions;
  busy: boolean;
  onSubmit: (answers: Record<string, string>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const setAnswer = (id: string, value: string) => setAnswers((a) => ({ ...a, [id]: value }));
  const allAnswered = pending.questions.every((q) => (answers[q.id] ?? '').trim().length > 0);

  return (
    <div
      className="card"
      style={{ margin: '0 12px 10px', padding: 14, borderColor: 'var(--accent)', background: 'var(--accent-soft)' }}
    >
      <div className="label-row" style={{ marginBottom: 10 }}>
        <CircleHelp size={18} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 15 }}>The agent has a question</strong>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {pending.questions.map((q) => (
          <div key={q.id}>
            <div style={{ fontSize: 14.5, marginBottom: 8, lineHeight: 1.45 }}>{q.question}</div>
            {q.options && q.options.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                {q.options.map((opt) => {
                  const active = answers[q.id] === opt;
                  return (
                    <button
                      key={opt}
                      onClick={() => setAnswer(q.id, opt)}
                      className="btn"
                      style={{
                        minHeight: 40,
                        padding: '0 14px',
                        fontSize: 14,
                        background: active ? 'var(--accent)' : 'var(--bg-elev-2)',
                        color: active ? 'var(--on-accent)' : 'var(--fg)',
                        border: `1px solid ${active ? 'var(--accent)' : 'var(--border-strong)'}`,
                      }}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            )}
            <input
              className="input"
              placeholder="Type an answer…"
              value={answers[q.id] ?? ''}
              onChange={(e) => setAnswer(q.id, e.target.value)}
            />
          </div>
        ))}
      </div>

      <button
        className="btn btn-primary btn-block"
        style={{ marginTop: 14 }}
        disabled={busy || !allAnswered}
        onClick={() => onSubmit(answers)}
      >
        <Send size={16} /> Send answer
      </button>
    </div>
  );
}
