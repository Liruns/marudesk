import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import { PatchDiff } from '@pierre/diffs/react';
import { DiffBlock } from '../../components/ui';
import { Spinner } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { toMessage } from '../../lib/toMessage';
import { parseUnifiedDiff } from './parseDiff';

// SPIKE flag: render the @pierre/diffs PatchDiff (syntax-highlighted, split
// view) instead of the in-house plain-text DiffBlock. Default off so shipped
// behavior is unchanged. `shiki-js` keeps highlighting off WebAssembly (no CSP
// `wasm-unsafe-eval` needed). See docs/pierre-diffs-spike.md.
const USE_PIERRE_DIFF = false;

// Map design tokens onto the diffs chrome (the library's first-class
// `--diffs-*-override` surface). Syntax colors come from the bundled
// `pierre-dark` theme; these retint the panel/gutter/line/number/selection
// backgrounds so the diff sits inside marudesk's surfaces. Emphasis (the
// word-level intra-line highlight) is a stronger token-derived tint via
// color-mix, keeping every value token-driven (no literal hex).
const DIFF_CHROME_STYLE = {
  '--diffs-bg-buffer-override': 'var(--surface-1)',
  '--diffs-bg-context-override': 'var(--surface-1)',
  '--diffs-bg-context-gutter-override': 'var(--surface-1)',
  '--diffs-bg-addition-override': 'var(--success-subtle)',
  '--diffs-bg-deletion-override': 'var(--error-subtle)',
  '--diffs-bg-addition-number-override': 'var(--success-subtle)',
  '--diffs-bg-deletion-number-override': 'var(--error-subtle)',
  '--diffs-bg-addition-emphasis-override': 'color-mix(in srgb, var(--success) 22%, transparent)',
  '--diffs-bg-deletion-emphasis-override': 'color-mix(in srgb, var(--error) 22%, transparent)',
  '--diffs-bg-separator-override': 'var(--surface-2)',
  '--diffs-bg-hover-override': 'var(--surface-2)',
  '--diffs-bg-selection-override': 'var(--accent-subtle)',
  '--diffs-fg-number-override': 'var(--text-tertiary)',
} as CSSProperties;

/**
 * A centered overlay showing the unified diff for one file (staged or not).
 * Mirrors the ModelPalette overlay shell (backdrop + centered card + Esc to
 * close); the body reuses the shared DiffBlock renderer via parseUnifiedDiff.
 */
export function DiffViewer({
  path,
  staged,
  onClose,
}: {
  path: string;
  staged: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Split is cramped in this narrow overlay, so default to unified and let the
  // user switch. Only meaningful on the @pierre/diffs path.
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>('unified');

  // This component is mounted fresh per target (the parent keys it on
  // path+staged), so path/staged never change during its life — no in-effect
  // reset is needed, and setState only ever runs in the async callbacks.
  useEffect(() => {
    let alive = true;
    window.marudesk
      .invoke('git:diff', { path, staged })
      .then((res) => {
        if (alive) setDiff(res.diff);
      })
      .catch((err) => {
        if (alive) setError(toMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [path, staged]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const lines = useMemo(() => (diff ? parseUnifiedDiff(diff) : []), [diff]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={`${t('git.diff.dialogLabel')} ${path}`}
    >
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/30"
        onClick={onClose}
      />
      <div
        className={cn(
          'relative mx-4 mt-[10vh] flex max-h-[80vh] w-full flex-col overflow-hidden',
          'rounded-xl border border-default bg-surface-1 shadow-lifted animate-scale-in',
          // Split needs more room; widen the overlay only when it's selected.
          USE_PIERRE_DIFF && diffStyle === 'split' ? 'max-w-5xl' : 'max-w-3xl',
        )}
      >
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-subtle pl-3 pr-1.5">
          {/* On the @pierre/diffs path, PatchDiff renders its own file header
              (icon + path + stats), so the overlay header carries only controls
              to avoid a duplicate path row. */}
          {USE_PIERRE_DIFF ? (
            <span className="text-caption font-medium uppercase tracking-wide text-fg-tertiary">
              {t('git.diff.dialogLabel')}
            </span>
          ) : (
            <span className="truncate font-mono text-body-sm text-fg-secondary" title={path}>
              {path}
            </span>
          )}
          {staged ? (
            <span className="shrink-0 rounded-pill bg-success/15 px-1.5 py-px text-[10px] font-medium text-success">
              {t('git.section.staged')}
            </span>
          ) : null}
          <span className="flex-1" aria-hidden />
          {USE_PIERRE_DIFF && diff !== null && diff.trim() !== '' ? (
            <div className="flex items-center rounded bg-surface-2 p-0.5">
              {(['unified', 'split'] as const).map((style) => (
                <button
                  key={style}
                  type="button"
                  onClick={() => setDiffStyle(style)}
                  aria-pressed={diffStyle === style}
                  className={cn(
                    'h-6 rounded-[4px] px-2 text-caption capitalize transition-colors duration-fast',
                    diffStyle === style
                      ? 'bg-surface-3 text-fg-primary'
                      : 'text-fg-tertiary hover:text-fg-secondary',
                  )}
                >
                  {style}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('git.diff.close')}
            title={t('git.diff.close')}
            className={cn(
              'size-7 rounded flex items-center justify-center shrink-0',
              'text-fg-tertiary hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast',
            )}
          >
            <X size={15} />
          </button>
        </header>
        <div
          className={cn(
            'min-h-0 flex-1 overflow-auto',
            // PatchDiff fills edge-to-edge (its sticky header pins to the top of
            // this scroll container); the in-house renderer keeps its padding.
            USE_PIERRE_DIFF && diff !== null && diff.trim() !== '' ? '' : 'p-3',
          )}
        >
          {error ? (
            <p className="p-3 text-body-sm text-error">{error}</p>
          ) : diff === null ? (
            <div className="flex items-center justify-center gap-2 py-10 text-fg-tertiary">
              <Spinner size={16} /> {t('git.diff.loading')}
            </div>
          ) : USE_PIERRE_DIFF ? (
            diff.trim() === '' ? (
              <p className="py-10 text-center text-body-sm text-fg-tertiary">
                {t('git.diff.empty')}
              </p>
            ) : (
              <PatchDiff
                patch={diff}
                options={{
                  theme: 'pierre-dark',
                  preferredHighlighter: 'shiki-js',
                  diffStyle,
                  // Highlight the whole changed line (the line-level add/remove
                  // tint) rather than boxing the changed tokens within it. This
                  // is calmer and matches the in-house DiffBlock, which also
                  // tints by line. ('word' / 'word-alt' / 'char' add intra-line
                  // emphasis boxes; see docs for the comparison.)
                  lineDiffType: 'none',
                  diffIndicators: 'bars',
                  expandUnchanged: true,
                  stickyHeader: true,
                }}
                className="text-body-sm"
                style={DIFF_CHROME_STYLE}
              />
            )
          ) : lines.length === 0 ? (
            <p className="py-10 text-center text-body-sm text-fg-tertiary">
              {t('git.diff.empty')}
            </p>
          ) : (
            <DiffBlock filePath={path} lines={lines} />
          )}
        </div>
      </div>
    </div>
  );
}
