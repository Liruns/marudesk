import type { TranslationKey } from '../../../i18n/messages';

/**
 * Localized labels for the free-form agent run-status strings shown in the
 * background-agent tray and the orchestration tree. The status arrives as a
 * plain string (shared/agent-orchestration AgentRunTreeNode.status), so unknown
 * values fall back to the raw string rather than a missing-key blank.
 */
const RUN_STATUS_KEY: Record<string, TranslationKey> = {
  running: 'agent.runStatus.running',
  busy: 'agent.runStatus.busy',
  idle: 'agent.runStatus.idle',
  done: 'agent.runStatus.done',
  completed: 'agent.runStatus.completed',
  error: 'agent.runStatus.error',
  failed: 'agent.runStatus.failed',
  cancelled: 'agent.runStatus.cancelled',
};

export function runStatusLabel(
  t: (key: TranslationKey) => string,
  status: string,
): string {
  const key = RUN_STATUS_KEY[status];
  return key ? t(key) : status;
}
