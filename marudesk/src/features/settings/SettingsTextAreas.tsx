import { useState } from 'react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';

export function GlobsField({
  value,
  onCommit,
}: {
  value: string[];
  onCommit: (value: string[]) => void;
}) {
  const text = value.join('\n');
  const [local, setLocal] = useState(text);
  const [committed, setCommitted] = useState(text);
  if (text !== committed) {
    setCommitted(text);
    setLocal(text);
  }
  const commit = () => {
    const next = local
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (next.join('\n') !== value.join('\n')) onCommit(next);
  };
  return (
    <textarea
      value={local}
      spellCheck={false}
      autoComplete="off"
      rows={5}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      placeholder={'**/.env\n**/secrets/**'}
      className={cn(
        'w-[320px] max-w-[40vw] rounded-md bg-surface-page border border-default px-3 py-2',
        'text-body-sm font-mono text-fg-primary placeholder:text-fg-tertiary resize-y',
        'focus:outline-none focus:border-accent transition-colors duration-fast',
      )}
    />
  );
}

export function InstructionsField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => void;
}) {
  const { t } = useI18n();
  const [local, setLocal] = useState(value);
  const [committed, setCommitted] = useState(value);
  if (value !== committed) {
    setCommitted(value);
    setLocal(value);
  }
  const commit = () => {
    if (local !== value) onCommit(local);
  };
  return (
    <textarea
      value={local}
      spellCheck={false}
      autoComplete="off"
      rows={5}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      placeholder={t('settings.agent.instructions.placeholder')}
      className={cn(
        'w-[320px] max-w-[40vw] rounded-md bg-surface-page border border-default px-3 py-2',
        'text-body-sm text-fg-primary placeholder:text-fg-tertiary resize-y',
        'focus:outline-none focus:border-accent transition-colors duration-fast',
      )}
    />
  );
}
