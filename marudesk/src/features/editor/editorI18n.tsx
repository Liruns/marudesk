import { Ban, Columns2, Eye, FileCode2, FileWarning, Pencil, WrapText } from 'lucide-react';
import type { ReactNode } from 'react';
import { MAX_EDITOR_FILE_SIZE } from '../../../shared/workspace';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import type { FileBuf } from './store';

export type MarkdownMode = 'edit' | 'preview' | 'split';

export function EditorMarkdownModeToggle({
  mode,
  onChange,
}: {
  mode: MarkdownMode;
  onChange: (mode: MarkdownMode) => void;
}) {
  const { t } = useI18n();
  const items: { value: MarkdownMode; Icon: typeof Pencil; label: string }[] = [
    { value: 'edit', Icon: Pencil, label: t('editor.markdown.edit') },
    { value: 'split', Icon: Columns2, label: t('editor.markdown.split') },
    { value: 'preview', Icon: Eye, label: t('editor.markdown.preview') },
  ];

  return (
    <div
      className="flex items-center gap-0.5"
      role="group"
      aria-label={t('editor.markdown.group')}
    >
      {items.map(({ value, Icon, label }) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={mode === value}
          onClick={() => onChange(value)}
          className={cn(
            'flex items-center justify-center size-5 rounded-sm transition-colors duration-fast',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
            mode === value
              ? 'bg-surface-3 text-fg-primary'
              : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-3/50',
          )}
        >
          <Icon size={12} />
        </button>
      ))}
    </div>
  );
}

export function EditorEmptyState() {
  const { t } = useI18n();
  return (
    <Centered
      icon={<FileCode2 size={22} />}
      title={t('editor.empty.title')}
      hint={t('editor.empty.hint')}
    />
  );
}

export function EditorErrorState({ path, buf }: { path: string; buf: FileBuf }) {
  const { locale, t } = useI18n();
  const { title, hint, icon } = describeError(path, buf, locale, t);
  return <Centered icon={icon} title={title} hint={hint} />;
}

export function EditorFooter({
  line,
  column,
  language,
  wordWrap,
  onToggleWordWrap,
}: {
  line: number;
  column: number;
  language: string;
  wordWrap: boolean;
  onToggleWordWrap: () => void;
}) {
  const { locale, t } = useI18n();
  const lineCol =
    locale === 'ko'
      ? `${t('editor.status.line')} ${line}, ${t('editor.status.column')} ${column}`
      : `${t('editor.status.line')} ${line}, ${t('editor.status.column')} ${column}`;

  return (
    <footer className="h-6 shrink-0 flex items-center gap-3 px-3 border-t border-subtle bg-surface-2 text-caption text-fg-tertiary tabular-nums select-none">
      <span>{lineCol}</span>
      <span className="uppercase tracking-wide">{language}</span>
      <span>{t('editor.status.spaces')}</span>
      <span className="flex-1" aria-hidden />
      <button
        type="button"
        aria-pressed={wordWrap}
        title={wordWrap ? t('editor.wrap.on') : t('editor.wrap.off')}
        onClick={onToggleWordWrap}
        className={cn(
          'inline-flex items-center gap-1 h-5 px-1.5 rounded-sm transition-colors duration-fast',
          wordWrap
            ? 'text-fg-primary bg-surface-3'
            : 'hover:text-fg-secondary hover:bg-surface-3/50',
        )}
      >
        <WrapText size={12} />
        {t('editor.wrap.label')}
      </button>
    </footer>
  );
}

type Translate = ReturnType<typeof useI18n>['t'];

function describeError(
  path: string,
  buf: FileBuf,
  locale: 'en' | 'ko',
  t: Translate,
): { title: string; hint: string; icon: ReactNode } {
  if (buf.reason === 'too-large') {
    const mb = buf.size ? (buf.size / 1048576).toFixed(1) : '?';
    const limitMb = (MAX_EDITOR_FILE_SIZE / 1048576).toFixed(0);
    return {
      title: t('editor.error.tooLarge.title'),
      hint:
        locale === 'ko'
          ? `${path} 파일은 ${mb}MB이며 편집기 제한 ${limitMb}MB를 넘습니다.`
          : `${path} is ${mb} MB - over the ${limitMb} MB editor limit.`,
      icon: <FileWarning size={22} />,
    };
  }
  if (buf.reason === 'binary') {
    return {
      title: t('editor.error.binary.title'),
      hint:
        locale === 'ko'
          ? `${path} 파일은 텍스트가 아니어서 여기서 편집할 수 없습니다.`
          : `${path} isn't text and can't be edited here.`,
      icon: <Ban size={22} />,
    };
  }
  if (buf.reason === 'not-a-file') {
    return {
      title: t('editor.error.notFile.title'),
      hint: path,
      icon: <Ban size={22} />,
    };
  }
  return {
    title: t('editor.error.open.title'),
    hint: buf.error ?? path,
    icon: <FileWarning size={22} />,
  };
}

function Centered({
  icon,
  title,
  hint,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-3 bg-surface-page text-center px-8">
      <span className="size-12 rounded-lg bg-surface-2 flex items-center justify-center text-fg-tertiary">
        {icon}
      </span>
      <h2 className="text-title text-fg-secondary">{title}</h2>
      <p className="text-body-sm text-fg-tertiary max-w-sm break-all">{hint}</p>
    </div>
  );
}
