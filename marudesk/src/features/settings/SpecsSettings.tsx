import { useEffect, useState } from 'react';
import { Check, ClipboardList, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Badge, type BadgeVariant, Button } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import type { TranslationKey } from '../../i18n/messages';
import { useWorkspaceStore } from '../workspace/store';
import { OpenFolderEmpty } from '../../components/OpenFolderEmpty';
import { humanizeError } from '../../lib/humanizeError';
import { SPEC_STATUSES, type Spec, type SpecStatus, type SpecTask } from '../../../shared/specs';

/**
 * Settings → Specs (§3.10). Plan a feature as a lightweight spec — title, notes,
 * and a checkable task list — stored per-workspace under `.marudesk/specs`. The
 * backend (specs:list/save/delete) shipped without a UI; this is its control
 * surface, mirroring the Automations panel's create/edit/delete shape.
 */
const STATUS_VARIANT: Record<SpecStatus, BadgeVariant> = {
  draft: 'neutral',
  active: 'accent',
  review: 'warning',
  done: 'success',
};

const STATUS_LABEL_KEY: Record<SpecStatus, TranslationKey> = {
  draft: 'settings.specs.status.draft',
  active: 'settings.specs.status.active',
  review: 'settings.specs.status.review',
  done: 'settings.specs.status.done',
};

let taskSeq = 0;
const blankTask = (): SpecTask => ({ id: `task-${Date.now()}-${(taskSeq += 1)}`, text: '', done: false });

export function SpecsSettings() {
  const { t } = useI18n();
  const hasWorkspace = useWorkspaceStore((s) => s.summary !== null);
  const [items, setItems] = useState<Spec[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // create / edit form — `editingId` flips between create and update.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<SpecStatus>('draft');
  const [tasks, setTasks] = useState<SpecTask[]>([]);

  const load = (): void => {
    if (!hasWorkspace) {
      setItems([]);
      return;
    }
    void window.marudesk
      .invoke('specs:list')
      .then((list) => {
        setItems(list);
        setError(null);
      })
      .catch((e) => {
        setItems([]);
        setError(humanizeError(e));
      });
  };
  useEffect(load, [hasWorkspace]);

  if (!hasWorkspace) {
    return (
      <OpenFolderEmpty
        title={t('workspace.emptyState.title')}
        body={t('settings.specs.noWorkspaceBody')}
        icon={ClipboardList}
      />
    );
  }

  const resetForm = (): void => {
    setEditingId(null);
    setTitle('');
    setBody('');
    setStatus('draft');
    setTasks([]);
  };

  const startEdit = (s: Spec): void => {
    setEditingId(s.id);
    setTitle(s.title);
    setBody(s.body);
    setStatus(s.status);
    setTasks(s.tasks.map((x) => ({ ...x })));
  };

  const submit = async (): Promise<void> => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await window.marudesk.invoke('specs:save', {
        id: editingId ?? undefined,
        title: title.trim(),
        body,
        status,
        tasks: tasks.filter((x) => x.text.trim()).map((x) => ({ ...x, text: x.text.trim() })),
      });
      resetForm();
      load();
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    await window.marudesk.invoke('specs:delete', { id }).catch((e) => setError(humanizeError(e)));
    if (editingId === id) resetForm();
    load();
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption text-fg-tertiary">{t('settings.specs.hint')}</p>
      {error ? <p className="text-caption text-error">{error}</p> : null}

      <div className="flex flex-col gap-2">
        {items === null ? (
          <Row text={t('settings.specs.loading')} />
        ) : items.length === 0 ? (
          <Row text={t('settings.specs.empty')} />
        ) : (
          items.map((s) => {
            const done = s.tasks.filter((x) => x.done).length;
            return (
              <div
                key={s.id}
                className="flex items-center gap-2 rounded-lg border border-subtle bg-surface-1 px-4 py-2"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-body-sm font-medium text-fg-primary truncate" title={s.title}>{s.title}</span>
                    <Badge variant={STATUS_VARIANT[s.status]}>{t(STATUS_LABEL_KEY[s.status])}</Badge>
                  </span>
                  <span className="flex items-center gap-1.5 text-caption text-fg-tertiary">
                    <ClipboardList size={11} className="shrink-0" />
                    {s.tasks.length > 0 ? (
                      <span className="tabular-nums">
                        {done}/{s.tasks.length} {t('settings.specs.tasksWord')}
                      </span>
                    ) : (
                      <span>{t('settings.specs.noTasks')}</span>
                    )}
                  </span>
                </div>
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => startEdit(s)}
                    title={t('settings.specs.edit')}
                    aria-label={t('settings.specs.edit')}
                    className={cn(
                      'text-fg-tertiary hover:text-accent transition-colors duration-fast',
                      editingId === s.id && 'text-accent',
                    )}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(s.id)}
                    title={t('settings.specs.delete')}
                    aria-label={t('settings.specs.delete')}
                    className="text-fg-tertiary hover:text-error transition-colors duration-fast"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* create / edit form */}
      <div
        className={cn(
          'flex flex-col gap-2 rounded-lg border bg-surface-1 p-3',
          editingId ? 'border-accent/60' : 'border-dashed border-subtle',
        )}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('settings.specs.titlePlaceholder')}
          className="rounded border border-subtle bg-surface-page px-2 py-1.5 text-body-sm text-fg-primary focus:outline-none focus:border-accent transition-colors duration-fast"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t('settings.specs.bodyPlaceholder')}
          rows={2}
          className="resize-none rounded border border-subtle bg-surface-page px-2 py-1.5 text-body-sm text-fg-primary focus:outline-none focus:border-accent transition-colors duration-fast"
        />

        {/* status segmented control */}
        <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-surface-2 self-start">
          {SPEC_STATUSES.map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatus(st)}
              aria-pressed={status === st}
              className={cn(
                'h-6 px-2.5 rounded text-caption font-medium transition-colors duration-fast active:scale-[0.99]',
                status === st
                  ? 'bg-surface-3 text-fg-primary'
                  : 'text-fg-secondary hover:text-fg-primary',
              )}
            >
              {t(STATUS_LABEL_KEY[st])}
            </button>
          ))}
        </div>

        {/* task checklist editor */}
        <div className="flex flex-col gap-1">
          {tasks.map((task) => (
            <div key={task.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setTasks((p) => p.map((x) => (x.id === task.id ? { ...x, done: !x.done } : x)))}
                aria-pressed={task.done}
                aria-label={task.done ? t('settings.specs.taskDone') : t('settings.specs.taskTodo')}
                className={cn(
                  'grid size-4 shrink-0 place-items-center rounded-sm border transition-colors duration-fast',
                  task.done
                    ? 'border-accent bg-accent text-white'
                    : 'border-default hover:border-strong',
                )}
              >
                {task.done ? <Check size={11} /> : null}
              </button>
              <input
                value={task.text}
                onChange={(e) =>
                  setTasks((p) => p.map((x) => (x.id === task.id ? { ...x, text: e.target.value } : x)))
                }
                placeholder={t('settings.specs.taskPlaceholder')}
                className={cn(
                  'flex-1 min-w-0 rounded border border-subtle bg-surface-page px-2 py-1 text-body-sm focus:outline-none focus:border-accent transition-colors duration-fast',
                  task.done ? 'text-fg-tertiary line-through' : 'text-fg-primary',
                )}
              />
              <button
                type="button"
                onClick={() => setTasks((p) => p.filter((x) => x.id !== task.id))}
                title={t('settings.specs.removeTask')}
                aria-label={t('settings.specs.removeTask')}
                className="shrink-0 grid size-6 place-items-center rounded text-fg-tertiary hover:text-error hover:bg-error-subtle transition-colors duration-fast"
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setTasks((p) => [...p, blankTask()])}
            className="self-start inline-flex items-center gap-1 text-caption text-fg-tertiary hover:text-fg-primary transition-colors duration-fast"
          >
            <Plus size={13} /> {t('settings.specs.addTask')}
          </button>
        </div>

        <div className="flex items-center justify-end gap-2">
          {editingId ? (
            <Button variant="ghost" size="sm" onClick={resetForm} disabled={busy}>
              {t('settings.specs.cancel')}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={editingId ? <Pencil size={14} /> : <Plus size={14} />}
            onClick={() => void submit()}
            disabled={busy || !title.trim()}
          >
            {t(editingId ? 'settings.specs.save' : 'settings.specs.create')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-subtle bg-surface-1 px-4 py-2 text-body-sm text-fg-tertiary">
      <ClipboardList size={15} className="shrink-0" />
      <span>{text}</span>
    </div>
  );
}
