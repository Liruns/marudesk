import { useState } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';
import { Button } from '../../../../components/ui';
import { useI18n } from '../../../../i18n/useI18n';
import { toast } from '../../../../lib/toast';
import { useAgentStore, useAgentBusy } from '../../store';

/* ── error recovery (v6 §W5/U4) ──────────────────────────────────────────── */

type RecoveryKey =
  | 'agent.chat.recovery.suggest.apiKey'
  | 'agent.chat.recovery.suggest.permission'
  | 'agent.chat.recovery.suggest.notFound'
  | 'agent.chat.recovery.suggest.timeout'
  | 'agent.chat.recovery.suggest.rateLimit'
  | 'agent.chat.recovery.suggest.generic';

/** Map a failure message to a plain-language next step (heuristic, best-effort). */
function recoverySuggestion(error: string): RecoveryKey {
  const e = error.toLowerCase();
  if (/api key|unauthor|\b401\b|invalid.*key/.test(e)) return 'agent.chat.recovery.suggest.apiKey';
  if (/permission|denied|eacces|blocked|deny glob/.test(e)) return 'agent.chat.recovery.suggest.permission';
  if (/not found|enoent|no such file|oldstring not found/.test(e)) return 'agent.chat.recovery.suggest.notFound';
  if (/timeout|timed out/.test(e)) return 'agent.chat.recovery.suggest.timeout';
  if (/rate limit|\b429\b|quota|overloaded/.test(e)) return 'agent.chat.recovery.suggest.rateLimit';
  return 'agent.chat.recovery.suggest.generic';
}

/**
 * Shown in place of a bare failed-turn error string (v6 §W5/U4): the full error
 * (expandable), a heuristic next-step hint, and a one-click Retry — optionally
 * steered by a short instruction — that re-prompts the agent with the failure
 * context instead of leaving the user to retype everything. Replaces the previous
 * static, truncated error line.
 */
export function ErrorRecoveryCard({ error }: { error: string }) {
  const { t } = useI18n();
  const submitPrompt = useAgentStore((s) => s.submitPrompt);
  const busy = useAgentBusy();
  const [guidance, setGuidance] = useState('');
  const [expanded, setExpanded] = useState(false);
  const long = error.length > 200;

  const retry = async () => {
    const tail = guidance.trim() || t('agent.chat.recovery.defaultTail');
    const prompt = `${t('agent.chat.recovery.promptHeader')}\n\n${error}\n\n${tail}`;
    const res = await submitPrompt(prompt);
    if (res.ok) setGuidance('');
    else if (res.reason && res.reason !== 'busy') {
      toast({ title: t('agent.chat.recovery.retryFailed'), description: res.reason, variant: 'error' });
    }
  };

  return (
    <div className="rounded-lg border border-error/35 bg-error-subtle/30 p-3 flex flex-col gap-2 shadow-card">
      <div className="flex items-start gap-2 text-body-sm text-fg-primary">
        <AlertCircle size={14} className="mt-0.5 shrink-0 text-error" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="break-words">
            {long && !expanded ? `${error.slice(0, 200)}…` : error}
          </span>
          {long ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="self-start text-caption text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
            >
              {expanded ? t('agent.chat.recovery.less') : t('agent.chat.recovery.more')}
            </button>
          ) : null}
          <span className="text-caption text-fg-tertiary">{t(recoverySuggestion(error))}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) {
              e.preventDefault();
              void retry();
            }
          }}
          placeholder={t('agent.chat.recovery.guidancePlaceholder')}
          className="h-7 flex-1 rounded-md bg-surface-page border border-default px-2 text-body-sm text-fg-primary focus:outline-none focus:border-accent transition-colors duration-fast"
        />
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void retry()}>
          <RotateCcw size={12} /> {t('agent.chat.recovery.retry')}
        </Button>
      </div>
    </div>
  );
}
