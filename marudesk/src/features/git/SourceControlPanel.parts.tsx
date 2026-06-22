import type { ReactNode } from 'react';
import { AlertTriangle, Download, GitBranch, RotateCcw } from 'lucide-react';
import { Spinner } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import type { GitChange } from '../../../shared/git';
import { useTabsStore } from '../tabs/store';
import { baseName, dirName, statusBadge } from './statusMeta';

export function NotARepo({
  onInit,
  busy,
  t,
}: {
  onInit: () => void;
  busy: boolean;
  t: ReturnType<typeof useI18n>['t'];
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="size-10 rounded-lg bg-surface-2 flex items-center justify-center text-fg-tertiary">
        <GitBranch size={20} />
      </span>
      <p className="text-body-sm text-fg-secondary">{t('git.empty.notRepoTitle')}</p>
      <p className="text-caption text-fg-tertiary">
        {t('git.empty.notRepoBody')}
      </p>
      <button
        type="button"
        onClick={onInit}
        disabled={busy}
        className={cn(
          'mt-1 inline-flex items-center gap-2 h-8 px-3 rounded-md text-body-sm',
          'bg-accent text-white transition-opacity duration-fast',
          busy ? 'opacity-60 cursor-not-allowed' : 'hover:opacity-90',
        )}
      >
        {busy ? <Spinner size={14} /> : <GitBranch size={15} />}
        {t('git.action.initRepo')}
      </button>
    </div>
  );
}

/** Failure-state when the first git probe throws (git:available / git:status IPC
 *  reject — e.g. no workspace open, so there's no root to run git in). Without
 *  this branch `status` stays null and the panel renders a perpetual "Loading…"
 *  spinner with the error swallowed; this shows the reason and a Retry instead. */
export function GitLoadError({
  message,
  onRetry,
  busy,
  t,
}: {
  message: string;
  onRetry: () => void;
  busy: boolean;
  t: ReturnType<typeof useI18n>['t'];
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="size-10 rounded-lg bg-error-subtle flex items-center justify-center text-error">
        <AlertTriangle size={20} />
      </span>
      <p className="text-body-sm text-fg-secondary">{t('git.empty.loadErrorTitle')}</p>
      <p className="max-w-sm break-words text-caption text-fg-tertiary">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        className={cn(
          'mt-1 inline-flex items-center gap-2 h-8 px-3 rounded-md text-body-sm',
          'bg-surface-2 text-fg-primary transition-colors duration-fast',
          busy ? 'opacity-60 cursor-not-allowed' : 'hover:bg-surface-3',
        )}
      >
        {busy ? <Spinner size={14} /> : <RotateCcw size={15} />}
        {t('git.action.retry')}
      </button>
    </div>
  );
}

/** Empty-state when no `git` binary is on PATH (a graceful alternative to every
 *  command failing with a raw ENOENT). marudesk doesn't bundle git — like
 *  VSCode/Cursor/Zed it uses the system one — so we point the user at the
 *  installer (opened in an in-app browser tab). */
export function GitMissing() {
  const { t } = useI18n();
  const openDownloads = () =>
    void useTabsStore.getState().newTab('web', 'https://git-scm.com/downloads');
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="size-10 rounded-lg bg-surface-2 flex items-center justify-center text-fg-tertiary">
        <GitBranch size={20} />
      </span>
      <p className="text-body-sm text-fg-secondary">{t('git.empty.missingTitle')}</p>
      <p className="text-caption text-fg-tertiary">
        {t('git.empty.missingBefore')}{' '}
        <code className="font-mono text-fg-secondary">git</code>{' '}
        {t('git.empty.missingAfter')}
      </p>
      <button
        type="button"
        onClick={openDownloads}
        className="mt-1 inline-flex items-center gap-2 h-8 px-3 rounded-md text-body-sm bg-accent text-white hover:opacity-90 transition-opacity duration-fast"
      >
        <Download size={15} /> {t('git.action.installGit')}
      </button>
    </div>
  );
}

export type RowAction = {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
};

/** A collapsible-free section header + its rows + a header-level bulk action. */
export function Section({
  title,
  count,
  action,
  icon,
  children,
}: {
  title: string;
  count: number;
  action: RowAction;
  /** Optional leading icon (e.g. the Merge Conflicts warning triangle). */
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="group/section">
      <div className="flex items-center gap-1.5 px-3 pb-1 pt-2.5">
        {icon}
        <span className="text-caption font-medium uppercase tracking-wide text-fg-tertiary">
          {title}
        </span>
        <span className="rounded-pill bg-surface-2 px-1.5 text-micro font-medium tabular-nums text-fg-secondary">
          {count}
        </span>
        <span className="flex-1" aria-hidden />
        {/* Bulk action stays visible (not hover-gated) so it's discoverable. */}
        <button
          type="button"
          onClick={action.onClick}
          aria-label={action.label}
          title={action.label}
          className="size-5 rounded flex items-center justify-center text-fg-tertiary/70 hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast"
        >
          {action.icon}
        </button>
      </div>
      <div>{children}</div>
    </div>
  );
}

/** One changed-file row: status badge + name + dir, hover-revealed actions. */
export function FileRow({
  change,
  staged,
  onOpen,
  actions,
}: {
  change: GitChange;
  staged: boolean;
  onOpen: () => void;
  actions: RowAction[];
}) {
  const { t } = useI18n();
  const badge = statusBadge(change, staged);
  const dir = dirName(change.path);
  return (
    <div className="group/row flex items-center gap-2 h-7 pl-3 pr-1.5 hover:bg-surface-2">
      {/* Leading status letter — a colored, fixed-width indicator so the eye can
          scan the change kind down the left edge. */}
      <span
        aria-hidden
        title={t(badge.titleKey)}
        className={cn(
          'w-3.5 shrink-0 text-center text-caption font-semibold tabular-nums',
          badge.className,
        )}
      >
        {badge.letter}
      </span>
      <button
        type="button"
        onClick={onOpen}
        title={change.path}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span className="truncate text-body-sm text-fg-primary">{baseName(change.path)}</span>
        {dir ? <span className="truncate text-caption text-fg-quaternary">{dir}</span> : null}
      </button>
      {/* Hover-revealed row actions on the right. */}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              a.onClick();
            }}
            aria-label={a.label}
            title={a.label}
            className={cn(
              'size-5 rounded flex items-center justify-center',
              'hover:bg-surface-3 transition-colors',
              a.danger ? 'text-fg-tertiary hover:text-error' : 'text-fg-tertiary hover:text-fg-primary',
            )}
          >
            {a.icon}
          </button>
        ))}
      </span>
    </div>
  );
}

export function IconButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'size-6 rounded flex items-center justify-center shrink-0',
        'transition-colors duration-fast',
        disabled
          ? 'text-fg-tertiary/40 cursor-not-allowed'
          : 'text-fg-tertiary hover:text-fg-primary hover:bg-surface-2',
      )}
    >
      {children}
    </button>
  );
}
