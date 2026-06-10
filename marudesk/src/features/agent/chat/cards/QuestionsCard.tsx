import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '../../../../components/ui';
import { useI18n } from '../../../../i18n/useI18n';
import { cn } from '../../../../lib/cn';
import type { PendingQuestions } from '../../../../../shared/agent';
import { useAgentStore } from '../../store';

/* ── ask_user questions (parked turns) ──────────────────────────────────── */

export function QuestionsCard({ pending }: { pending: PendingQuestions }) {
  const { t } = useI18n();
  const answer = useAgentStore((s) => s.answer);
  const [values, setValues] = useState<Record<string, string>>({});

  const submit = () => void answer(pending.callId, values);

  return (
    <div className="rounded-lg border border-accent/35 bg-accent-subtle/15 p-3 flex flex-col gap-2.5 shadow-card">
      <div className="flex items-center gap-2 text-body-sm text-fg-primary">
        <Sparkles size={14} className="shrink-0 text-accent" /> {t('agent.chat.needsInput')}
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
                    'h-6 px-2 rounded border text-caption transition-colors duration-fast',
                    values[q.id] === opt
                      ? 'border-accent text-fg-primary bg-accent-subtle/40'
                      : 'border-subtle text-fg-tertiary hover:text-fg-secondary hover:border-default',
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
            placeholder={t('agent.chat.answerPlaceholder')}
            className="h-7 rounded-md bg-surface-page border border-default px-2 text-body-sm text-fg-primary focus:outline-none focus:border-accent transition-colors duration-fast"
          />
        </div>
      ))}
      <Button variant="primary" size="sm" onClick={submit}>
        {t('agent.chat.sendAnswer')}
      </Button>
    </div>
  );
}
