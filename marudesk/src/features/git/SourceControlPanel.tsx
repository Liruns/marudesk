import {
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  History,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
} from 'lucide-react';
import { Spinner } from '../../components/ui';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { readStoredWidth, writeStoredWidth } from '../../lib/panelWidth';
import { bucketChanges, useGitStore } from './store';
import { relativeTime } from './statusMeta';
import {
  FileRow,
  GitMissing,
  IconButton,
  NotARepo,
  Section,
} from './SourceControlPanel.parts';
import { DiffViewer } from './DiffViewer';
import { WorktreeIsolationBar } from './WorktreeIsolationBar';
import { WorktreeLanes } from './WorktreeLanes';
import { useEditorStore } from '../editor/store';
import { useWorkspaceStore } from '../workspace/store';

type Props = {
  open: boolean;
  onRequestClose?: () => void;
};

// Width persistence + drag-to-close, mirroring ExplorerPanel.
const SC_MIN = 160;
const SC_MAX = 600;
const SC_DEFAULT = 300;
const SC_WIDTH_KEY = 'marudesk.sourceControlWidth';
const SC_CLOSE_AT = 88;
const SC_DRAG_FLOOR = 52;

function readWidth(): number {
  return readStoredWidth(SC_WIDTH_KEY, SC_MIN, SC_MAX, SC_DEFAULT);
}

/** What the diff overlay is currently showing. */
type DiffTarget = { path: string; staged: boolean };

/**
 * Left-hand Source Control sidebar — a VSCode-style git panel for the open
 * workspace. Header carries the branch name + fetch/sync; below it a commit
 * box, then Staged / Changes / Untracked sections (each row has stage/unstage/
 * discard hover actions and opens a diff on click), then a collapsible recent
 * commits log. Refreshes on open and after every mutating op (the store
 * actions refresh themselves).
 *
 * Reuses ExplorerPanel's resize/drag-to-close mechanics so the two side panels
 * feel identical.
 */
export function SourceControlPanel({ open, onRequestClose }: Props) {
  const { t } = useI18n();
  const status = useGitStore((s) => s.status);
  const available = useGitStore((s) => s.available);
  const branches = useGitStore((s) => s.branches);
  const log = useGitStore((s) => s.log);
  const loading = useGitStore((s) => s.loading);
  const busy = useGitStore((s) => s.busy);
  const error = useGitStore((s) => s.error);
  const refresh = useGitStore((s) => s.refresh);
  const init = useGitStore((s) => s.init);
  const stage = useGitStore((s) => s.stage);
  const stageAll = useGitStore((s) => s.stageAll);
  const unstage = useGitStore((s) => s.unstage);
  const discard = useGitStore((s) => s.discard);
  const commit = useGitStore((s) => s.commit);
  const checkout = useGitStore((s) => s.checkout);
  const createBranch = useGitStore((s) => s.createBranch);
  const fetch = useGitStore((s) => s.fetch);
  const pull = useGitStore((s) => s.pull);
  const push = useGitStore((s) => s.push);
  const stashes = useGitStore((s) => s.stashes);
  const conflictOp = useGitStore((s) => s.conflictOp);
  const stashPush = useGitStore((s) => s.stashPush);
  const stashApply = useGitStore((s) => s.stashApply);
  const stashPop = useGitStore((s) => s.stashPop);
  const stashDrop = useGitStore((s) => s.stashDrop);
  const conflictResolve = useGitStore((s) => s.conflictResolve);
  const conflictContinue = useGitStore((s) => s.conflictContinue);
  const conflictAbort = useGitStore((s) => s.conflictAbort);
  const openFile = useEditorStore((s) => s.openFile);
  // The active workspace root — when it changes (profile/workspace switch), the
  // main process is now pointed at a different repo, so re-run git status against
  // it without waiting for the panel to be reopened.
  const workspaceRoot = useWorkspaceStore((s) => s.summary?.root ?? null);

  const [width, setWidth] = useState(readWidth);
  const [resizing, setResizing] = useState(false);
  const [inCloseZone, setInCloseZone] = useState(false);
  const [message, setMessage] = useState('');
  const [logOpen, setLogOpen] = useState(false);
  const [stashesOpen, setStashesOpen] = useState(false);
  const [stashPromptOpen, setStashPromptOpen] = useState(false);
  const [stashMessage, setStashMessage] = useState('');
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number } | null>(null);

  // Refresh status whenever the panel transitions to open (VSCode refreshes the
  // SCM view on focus) OR the active workspace root changes under it (profile /
  // workspace switch). No file-watching for the MVP — manual + post-op only.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh, workspaceRoot]);

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const asideLeft = handle.parentElement?.getBoundingClientRect().left ?? 0;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    let last = width;
    let lastGood = width >= SC_MIN ? width : SC_DEFAULT;
    const onMove = (ev: PointerEvent) => {
      last = Math.min(SC_MAX, Math.max(SC_DRAG_FLOOR, ev.clientX - asideLeft));
      if (last >= SC_MIN) lastGood = last;
      setWidth(last);
      setInCloseZone(last < SC_CLOSE_AT);
    };
    const onDone = () => {
      setResizing(false);
      setInCloseZone(false);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('lostpointercapture', onDone);
      if (last < SC_CLOSE_AT) {
        const restore = lastGood >= SC_MIN ? lastGood : SC_DEFAULT;
        setWidth(restore);
        persistWidth(restore);
        onRequestClose?.();
      } else {
        const clamped = Math.min(SC_MAX, Math.max(SC_MIN, last));
        setWidth(clamped);
        persistWidth(clamped);
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('lostpointercapture', onDone);
  };

  const buckets = useMemo(
    () => (status?.isRepo ? bucketChanges(status.files) : null),
    [status],
  );
  const hasStaged = !!buckets && buckets.staged.length > 0;
  const hasUnstaged =
    !!buckets && (buckets.changes.length > 0 || buckets.untracked.length > 0);
  const hasConflicts = !!buckets && buckets.conflicts.length > 0;
  const canCommit = hasStaged && message.trim().length > 0 && !busy;
  const canStash = (hasStaged || hasUnstaged) && !busy;

  const onCommit = async () => {
    if (!canCommit) return;
    const ok = await commit(message.trim());
    if (ok) setMessage('');
  };

  const onStash = async () => {
    if (!canStash) return;
    const ok = await stashPush(stashMessage.trim() || undefined);
    if (ok) {
      setStashMessage('');
      setStashPromptOpen(false);
    }
  };

  const onStashDrop = (ref: string) => {
    if (window.confirm(t('git.stash.dropConfirm'))) void stashDrop(ref);
  };

  const onConflictAbort = () => {
    if (window.confirm(t('git.conflict.abortConfirm'))) void conflictAbort();
  };

  const onDiscard = (paths: string[], label: string) => {
    if (paths.length === 0) return;
    const ok = window.confirm(
      paths.length === 1
        ? `${t('git.confirm.discardOneBefore')}"${label}"${t('git.confirm.discardOneAfter')}`
        : `${t('git.confirm.discardManyBefore')}${paths.length}${t('git.confirm.discardManyAfter')}`,
    );
    if (ok) void discard(paths);
  };

  const onCreateBranch = () => {
    const name = window.prompt(t('git.branch.newPrompt'))?.trim();
    if (name) void createBranch(name);
  };

  // The branch switcher: every local branch (current marked), then "Create
  // branch…". Stays small — this isn't a full branch manager for the MVP.
  const branchMenuItems = (): MenuItem[] => {
    const items: MenuItem[] = (branches?.branches ?? []).map((name) => ({
      label: name,
      icon: name === branches?.current ? <Check size={14} /> : <GitBranch size={14} />,
      disabled: name === branches?.current,
      onSelect: () => void checkout(name),
    }));
    items.push(
      { type: 'separator' },
      { label: t('git.branch.create'), icon: <Plus size={14} />, onSelect: onCreateBranch },
    );
    return items;
  };

  const closeZoneActive = resizing && inCloseZone;

  return (
    <aside
      role="complementary"
      aria-label={t('git.panel.label')}
      aria-hidden={!open}
      className={cn(
        'relative shrink-0 bg-surface-1 border-r border-subtle overflow-hidden',
        resizing ? '' : 'transition-[width] duration-standard',
      )}
      style={{ width: open ? width : 0 }}
    >
      <div
        className={cn(
          'h-full flex flex-col',
          closeZoneActive
            ? 'opacity-30 transition-opacity duration-fast'
            : 'transition-opacity duration-fast',
        )}
        style={{ width }}
      >
        <header className="h-9 shrink-0 flex items-center justify-between pl-3 pr-1.5 border-b border-subtle">
          <h2 className="text-caption font-medium uppercase tracking-wide text-fg-tertiary">
            {t('git.panel.title')}
          </h2>
          <div className="flex items-center gap-0.5">
            {status?.isRepo && hasUnstaged ? (
              <IconButton label={t('git.action.stageAllChanges')} onClick={() => void stageAll()} disabled={busy}>
                <Plus size={15} />
              </IconButton>
            ) : null}
            {status?.isRepo ? (
              <IconButton
                label={t('git.action.stash')}
                onClick={() => setStashPromptOpen((v) => !v)}
                disabled={busy}
              >
                <Archive size={14} />
              </IconButton>
            ) : null}
            {available?.installed === false ? null : (
              <IconButton label={t('git.action.fetch')} onClick={() => void fetch()} disabled={busy}>
                <RefreshCw size={14} />
              </IconButton>
            )}
            <IconButton label={t('git.action.refresh')} onClick={() => void refresh()} disabled={loading}>
              <RotateCcw size={14} />
            </IconButton>
          </div>
        </header>

        {available && !available.installed ? (
          <GitMissing />
        ) : status === null ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-fg-tertiary">
            <Spinner size={16} /> {t('git.loading')}
          </div>
        ) : !status.isRepo ? (
          <NotARepo onInit={() => void init()} busy={busy} t={t} />
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            {/* branch + ahead/behind + sync/pull/push */}
            <div className="shrink-0 flex items-center gap-1.5 px-3 h-8 border-b border-subtle">
              <button
                type="button"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setBranchMenu({ x: r.left, y: r.bottom + 4 });
                }}
                title={
                  status.upstream
                    ? `${t('git.branch.tracking')} ${status.upstream} - ${t('git.branch.switch')}`
                    : t('git.branch.switch')
                }
                className="flex min-w-0 items-center gap-1.5 rounded px-1 -mx-1 h-6 text-fg-secondary hover:bg-surface-2 transition-colors"
              >
                <GitBranch size={13} className="shrink-0 text-fg-tertiary" />
                <span className="truncate text-body-sm">
                  {status.branch ?? (status.unborn ? t('git.branch.unborn') : t('git.branch.detached'))}
                </span>
              </button>
              {status.ahead > 0 || status.behind > 0 ? (
                <span className="shrink-0 flex items-center gap-1 text-caption text-fg-tertiary tabular-nums">
                  {status.behind > 0 ? <span title={t('git.branch.behind')}>↓{status.behind}</span> : null}
                  {status.ahead > 0 ? <span title={t('git.branch.ahead')}>↑{status.ahead}</span> : null}
                </span>
              ) : null}
              <span className="flex-1" aria-hidden />
              <IconButton label={t('git.action.pull')} onClick={() => void pull()} disabled={busy || !status.upstream}>
                <ChevronDown size={14} />
              </IconButton>
              <IconButton label={t('git.action.push')} onClick={() => void push()} disabled={busy || !status.upstream}>
                <Upload size={13} />
              </IconButton>
            </div>

            {/* Agent worktree isolation (Stage 12-B) — only for a local git repo. */}
            <WorktreeIsolationBar />

            {/* Worktree lanes board — every worktree of the repo (§3.8). */}
            <WorktreeLanes />

            {/* merge-conflict banner: names the in-progress operation; offers
                Continue (once every conflict is resolved) and Abort. */}
            {conflictOp !== null || hasConflicts ? (
              <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 border-b border-subtle bg-warning-subtle">
                <TriangleAlert size={13} className="shrink-0 text-warning" />
                <span className="min-w-0 flex-1 truncate text-caption text-fg-secondary">
                  {conflictOp === 'merge'
                    ? t('git.conflict.banner.merge')
                    : conflictOp === 'rebase'
                      ? t('git.conflict.banner.rebase')
                      : conflictOp === 'cherry-pick'
                        ? t('git.conflict.banner.cherryPick')
                        : t('git.conflict.banner.conflicts')}
                </span>
                {conflictOp !== null ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void conflictContinue()}
                      disabled={busy || hasConflicts}
                      title={hasConflicts ? undefined : t('git.conflict.resolvedHint')}
                      className={cn(
                        'shrink-0 h-5 px-1.5 rounded text-caption font-medium transition-colors duration-fast',
                        busy || hasConflicts
                          ? 'text-fg-tertiary/60 cursor-not-allowed'
                          : 'text-success hover:bg-surface-2',
                      )}
                    >
                      {t('git.conflict.continue')}
                    </button>
                    <button
                      type="button"
                      onClick={onConflictAbort}
                      disabled={busy}
                      className={cn(
                        'shrink-0 h-5 px-1.5 rounded text-caption font-medium transition-colors duration-fast',
                        busy
                          ? 'text-fg-tertiary/60 cursor-not-allowed'
                          : 'text-error hover:bg-surface-2',
                      )}
                    >
                      {t('git.conflict.abort')}
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}

            {/* commit box */}
            <div className="shrink-0 p-2 border-b border-subtle">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  // Ctrl/Cmd+Enter commits (VSCode parity).
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void onCommit();
                  }
                }}
                rows={2}
                placeholder={
                  hasStaged ? t('git.commit.placeholderReady') : t('git.commit.placeholderEmpty')
                }
                spellCheck={false}
                className={cn(
                  'w-full resize-none rounded border border-subtle bg-surface-2 px-2 py-1.5',
                  'text-body-sm text-fg-primary placeholder:text-fg-tertiary',
                  'focus:outline-none focus:border-accent',
                )}
              />
              <button
                type="button"
                onClick={() => void onCommit()}
                disabled={!canCommit}
                className={cn(
                  'mt-1.5 inline-flex w-full items-center justify-center gap-2 h-7 rounded text-body-sm font-medium',
                  'transition-colors duration-fast',
                  canCommit
                    ? 'bg-accent text-white hover:bg-accent-hover'
                    : 'bg-surface-2 text-fg-tertiary cursor-not-allowed',
                )}
              >
                <Check size={14} /> {t('git.action.commit')}
                {hasStaged && buckets ? (
                  <span className="tabular-nums opacity-80">({buckets.staged.length})</span>
                ) : null}
              </button>
            </div>

            {/* inline stash prompt (Archive in the header toggles it) */}
            {stashPromptOpen ? (
              <div className="shrink-0 flex items-center gap-1.5 p-2 border-b border-subtle">
                <input
                  value={stashMessage}
                  onChange={(e) => setStashMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void onStash();
                    } else if (e.key === 'Escape') {
                      setStashPromptOpen(false);
                    }
                  }}
                  placeholder={t('git.stash.placeholder')}
                  spellCheck={false}
                  autoFocus
                  className={cn(
                    'min-w-0 flex-1 h-7 rounded border border-subtle bg-surface-2 px-2',
                    'text-body-sm text-fg-primary placeholder:text-fg-tertiary',
                    'focus:outline-none focus:border-accent',
                  )}
                />
                <button
                  type="button"
                  onClick={() => void onStash()}
                  disabled={!canStash}
                  className={cn(
                    'shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-body-sm font-medium',
                    'transition-colors duration-fast',
                    canStash
                      ? 'bg-accent text-white hover:bg-accent-hover'
                      : 'bg-surface-2 text-fg-tertiary cursor-not-allowed',
                  )}
                >
                  <Archive size={13} /> {t('git.stash.save')}
                </button>
              </div>
            ) : null}

            {error ? (
              <p className="shrink-0 px-3 py-1.5 text-caption text-error border-b border-subtle">
                {error}
              </p>
            ) : null}

            {/* change sections */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {buckets && buckets.staged.length === 0 && buckets.changes.length === 0 && buckets.untracked.length === 0 && buckets.conflicts.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-3 py-10 text-center text-caption text-fg-tertiary">
                  <GitCommitHorizontal size={18} className="opacity-30" />
                  <span>{t('git.empty.noChanges')}</span>
                </div>
              ) : null}

              {buckets && buckets.conflicts.length > 0 ? (
                <Section
                  title={t('git.section.conflicts')}
                  count={buckets.conflicts.length}
                  icon={<TriangleAlert size={12} className="shrink-0 text-warning" />}
                  action={{
                    icon: <Check size={13} />,
                    label: t('git.conflict.markAllResolved'),
                    onClick: () => void stage(buckets.conflicts.map((f) => f.path)),
                  }}
                >
                  {buckets.conflicts.map((f) => (
                    <FileRow
                      key={`x:${f.path}`}
                      change={f}
                      staged={false}
                      onOpen={() => void openFile(f.path)}
                      actions={[
                        {
                          icon: <ArrowLeft size={13} />,
                          label: t('git.conflict.acceptOurs'),
                          onClick: () => void conflictResolve(f.path, 'ours'),
                        },
                        {
                          icon: <ArrowRight size={13} />,
                          label: t('git.conflict.acceptTheirs'),
                          onClick: () => void conflictResolve(f.path, 'theirs'),
                        },
                        {
                          icon: <Check size={13} />,
                          label: t('git.conflict.markResolved'),
                          onClick: () => void stage([f.path]),
                        },
                      ]}
                    />
                  ))}
                </Section>
              ) : null}

              {buckets && buckets.staged.length > 0 ? (
                <Section
                  title={t('git.section.stagedChanges')}
                  count={buckets.staged.length}
                  action={{
                    icon: <Minus size={13} />,
                    label: t('git.action.unstageAll'),
                    onClick: () => void unstage(buckets.staged.map((f) => f.path)),
                  }}
                >
                  {buckets.staged.map((f) => (
                    <FileRow
                      key={`s:${f.path}`}
                      change={f}
                      staged
                      onOpen={() => setDiff({ path: f.path, staged: true })}
                      actions={[
                        { icon: <Minus size={13} />, label: t('git.action.unstage'), onClick: () => void unstage([f.path]) },
                      ]}
                    />
                  ))}
                </Section>
              ) : null}

              {buckets && buckets.changes.length > 0 ? (
                <Section
                  title={t('git.section.changes')}
                  count={buckets.changes.length}
                  action={{
                    icon: <Plus size={13} />,
                    label: t('git.action.stageAll'),
                    onClick: () => void stage(buckets.changes.map((f) => f.path)),
                  }}
                >
                  {buckets.changes.map((f) => (
                    <FileRow
                      key={`c:${f.path}`}
                      change={f}
                      staged={false}
                      onOpen={() => setDiff({ path: f.path, staged: false })}
                      actions={[
                        {
                          icon: <Undo2 size={13} />,
                          label: t('git.action.discardChanges'),
                          danger: true,
                          onClick: () => onDiscard([f.path], f.path),
                        },
                        { icon: <Plus size={13} />, label: t('git.action.stage'), onClick: () => void stage([f.path]) },
                      ]}
                    />
                  ))}
                </Section>
              ) : null}

              {buckets && buckets.untracked.length > 0 ? (
                <Section
                  title={t('git.section.untracked')}
                  count={buckets.untracked.length}
                  action={{
                    icon: <Plus size={13} />,
                    label: t('git.action.stageAll'),
                    onClick: () => void stage(buckets.untracked.map((f) => f.path)),
                  }}
                >
                  {buckets.untracked.map((f) => (
                    <FileRow
                      key={`u:${f.path}`}
                      change={f}
                      staged={false}
                      onOpen={() => void openFile(f.path)}
                      actions={[
                        {
                          icon: <Trash2 size={13} />,
                          label: t('git.action.deleteFile'),
                          danger: true,
                          onClick: () => onDiscard([f.path], f.path),
                        },
                        { icon: <Plus size={13} />, label: t('git.action.stage'), onClick: () => void stage([f.path]) },
                      ]}
                    />
                  ))}
                </Section>
              ) : null}
            </div>

            {/* recent commits log */}
            <div className="shrink-0 border-t border-subtle">
              <button
                type="button"
                onClick={() => setLogOpen((v) => !v)}
                className="flex w-full items-center gap-1.5 px-3 h-7 text-caption uppercase tracking-wide text-fg-tertiary hover:text-fg-secondary"
              >
                {logOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <History size={12} />
                <span>{t('git.section.recent')}</span>
                {log.length > 0 ? <span className="tabular-nums">{log.length}</span> : null}
              </button>
              {logOpen ? (
                <div className="max-h-40 overflow-y-auto pb-1">
                  {log.length === 0 ? (
                    <p className="px-3 py-2 text-caption text-fg-tertiary">{t('git.empty.noCommits')}</p>
                  ) : (
                    log.map((c) => (
                      <div
                        key={c.hash}
                        className="px-3 py-1 flex items-baseline gap-2 text-caption"
                        title={`${c.author} · ${c.relDate}`}
                      >
                        <GitCommitHorizontal size={11} className="shrink-0 translate-y-0.5 text-fg-tertiary" />
                        <code className="shrink-0 text-fg-tertiary tabular-nums">{c.shortHash}</code>
                        <span className="truncate text-fg-secondary">{c.subject}</span>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>

            {/* stashes — collapsible, mirrors the recent-commits section */}
            <div className="shrink-0 border-t border-subtle">
              <button
                type="button"
                onClick={() => setStashesOpen((v) => !v)}
                className="flex w-full items-center gap-1.5 px-3 h-7 text-caption uppercase tracking-wide text-fg-tertiary hover:text-fg-secondary"
              >
                {stashesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Archive size={12} />
                <span>{t('git.section.stashes')}</span>
                {stashes.length > 0 ? <span className="tabular-nums">{stashes.length}</span> : null}
              </button>
              {stashesOpen ? (
                <div className="max-h-40 overflow-y-auto pb-1">
                  {stashes.length === 0 ? (
                    <p className="px-3 py-2 text-caption text-fg-tertiary">{t('git.stash.empty')}</p>
                  ) : (
                    stashes.map((s) => (
                      <div
                        key={s.ref}
                        className="group/stash flex h-7 items-center gap-2 pl-3 pr-1.5 text-caption hover:bg-surface-2"
                        title={`${s.ref} · ${s.message}`}
                      >
                        <Archive size={11} className="shrink-0 text-fg-tertiary" />
                        <span className="min-w-0 flex-1 truncate text-fg-secondary">{s.message}</span>
                        <span className="shrink-0 text-fg-tertiary tabular-nums group-hover/stash:hidden">
                          {relativeTime(s.timestamp * 1000)}
                        </span>
                        <span className="hidden shrink-0 items-center gap-0.5 group-hover/stash:flex">
                          {[
                            {
                              icon: <ArchiveRestore size={13} />,
                              label: t('git.stash.apply'),
                              danger: false,
                              onClick: () => void stashApply(s.ref),
                            },
                            {
                              icon: <ArrowUpFromLine size={13} />,
                              label: t('git.stash.pop'),
                              danger: false,
                              onClick: () => void stashPop(s.ref),
                            },
                            {
                              icon: <Trash2 size={13} />,
                              label: t('git.stash.drop'),
                              danger: true,
                              onClick: () => onStashDrop(s.ref),
                            },
                          ].map((a) => (
                            <button
                              key={a.label}
                              type="button"
                              onClick={a.onClick}
                              disabled={busy}
                              aria-label={a.label}
                              title={a.label}
                              className={cn(
                                'size-5 rounded flex items-center justify-center',
                                'hover:bg-surface-3 transition-colors',
                                a.danger
                                  ? 'text-fg-tertiary hover:text-error'
                                  : 'text-fg-tertiary hover:text-fg-primary',
                                busy ? 'opacity-50 cursor-not-allowed' : '',
                              )}
                            >
                              {a.icon}
                            </button>
                          ))}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {open ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('git.panel.resize')}
          onPointerDown={onResizeStart}
          className={cn(
            'absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize',
            'transition-colors duration-fast',
            closeZoneActive ? 'bg-error' : resizing ? 'bg-accent' : 'bg-transparent hover:bg-accent/60',
          )}
        >
          <span aria-hidden className="absolute inset-y-0 -left-1 right-0" />
          {closeZoneActive ? (
            <span
              aria-hidden
              className={cn(
                'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2',
                'whitespace-nowrap px-2 py-1 rounded',
                'bg-surface-2 text-error text-caption pointer-events-none select-none',
              )}
            >
              {t('git.panel.releaseToClose')}
            </span>
          ) : null}
        </div>
      ) : null}

      {diff ? (
        <DiffViewer
          key={`${diff.staged ? 's' : 'w'}:${diff.path}`}
          path={diff.path}
          staged={diff.staged}
          onClose={() => setDiff(null)}
        />
      ) : null}

      {branchMenu ? (
        <ContextMenu
          x={branchMenu.x}
          y={branchMenu.y}
          items={branchMenuItems()}
          onClose={() => setBranchMenu(null)}
        />
      ) : null}
    </aside>
  );
}

function persistWidth(w: number): void {
  writeStoredWidth(SC_WIDTH_KEY, w);
}
