import type { TaskStatus } from '../../../shared/work-os';
import type { BadgeVariant } from '../../components/ui/Badge';
import type { TranslationKey } from '../../i18n/messages';

/**
 * Canonical per-status maps shared by the Task graph node, the dock inspector,
 * and the Flight Log so a new {@link TaskStatus} cannot silently desync the label
 * key or badge variant across surfaces. Both maps are `Record<TaskStatus, …>`, so
 * adding a status fails to typecheck in this ONE place until it is filled in.
 */

/** Human status labels resolve through the shared Flight Log i18n keys. */
export const STATUS_LABEL_KEY: Record<TaskStatus, TranslationKey> = {
  planned: 'flightLog.status.planned',
  running: 'flightLog.status.running',
  done: 'flightLog.status.done',
  blocked: 'flightLog.status.blocked',
  needs_review: 'flightLog.status.needsReview',
  failed: 'flightLog.status.failed',
};

/** Status → Badge variant (token-only styling lives in the Badge component). */
export const STATUS_BADGE: Record<TaskStatus, BadgeVariant> = {
  planned: 'neutral',
  running: 'accent',
  done: 'success',
  blocked: 'warning',
  needs_review: 'warning',
  failed: 'error',
};
