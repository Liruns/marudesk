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
    <div className="question-panel">
      <div className="question-panel__header">
        <CircleHelp size={18} />
        <strong>The agent has a question</strong>
      </div>

      <div className="question-panel__list">
        {pending.questions.map((q) => (
          <div key={q.id}>
            <div className="question-panel__question">{q.question}</div>
            {q.options && q.options.length > 0 && (
              <div className="question-panel__options">
                {q.options.map((opt) => {
                  const active = answers[q.id] === opt;
                  return (
                    <button
                      key={opt}
                      onClick={() => setAnswer(q.id, opt)}
                      className={active ? 'question-panel__option is-active' : 'question-panel__option'}
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
        style={{ marginTop: 12 }}
        disabled={busy || !allAnswered}
        onClick={() => onSubmit(answers)}
      >
        <Send size={16} /> Send answer
      </button>
    </div>
  );
}
