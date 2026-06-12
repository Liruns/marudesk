import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Plus, SendHorizontal, Square, Trash2, X } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { focusOrOpenAgentTab, useAgentStore } from '../agent/store';
import { SPEC_STATUSES, type Spec, type SpecStatus, type SpecTask } from '../../../shared/specs';

/**
 * Spec lifecycle panel (§3.10): per-workspace specs (title + markdown body +
 * checkable task list) stored under .marudesk/specs. Create, edit, track tasks,
 * and hand a spec to the agent as a focused turn. Backend is the specs:* IPC;
 * this panel is the editing surface.
 */
function taskProgress(tasks: SpecTask[]): string {
  return `${tasks.filter((t) => t.done).length}/${tasks.length}`;
}

const STATUS_CLASS: Record<SpecStatus, string> = {
  draft: 'bg-surface-3 text-fg-tertiary',
  active: 'bg-accent-subtle text-accent',
  review: 'bg-warning-subtle text-warning',
  done: 'bg-success-subtle text-success',
};

/** Advance the spec through draft → active → review → done → draft. */
function nextStatus(s: SpecStatus): SpecStatus {
  return SPEC_STATUSES[(SPEC_STATUSES.indexOf(s) + 1) % SPEC_STATUSES.length];
}

export function SpecsPanel() {
  const { t } = useI18n();
  const submitPrompt = useAgentStore((s) => s.submitPrompt);
  const [specs, setSpecs] = useState<Spec[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newTask, setNewTask] = useState('');

  const refresh = () =>
    void window.marudesk
      .invoke('specs:list')
      .then(setSpecs)
      .catch(() => setSpecs([]));
  useEffect(() => refresh(), []);

  const persist = async (spec: Spec): Promise<void> => {
    const saved = await window.marudesk.invoke('specs:save', {
      id: spec.id,
      title: spec.title,
      body: spec.body,
      status: spec.status,
      tasks: spec.tasks,
    });
    setSpecs((cur) => (cur ?? []).map((s) => (s.id === saved.id ? saved : s)));
  };

  const create = async (): Promise<void> => {
    // Electron renderers don't support window.prompt — create with a default
    // title and let the user rename inline (title input in the expanded view).
    const saved = await window.marudesk.invoke('specs:save', {
      title: t('specs.defaultTitle'),
      body: '',
      tasks: [],
    });
    setSpecs((cur) => [saved, ...(cur ?? [])]);
    setOpenId(saved.id);
  };

  const remove = async (spec: Spec): Promise<void> => {
    if (!window.confirm(`${t('specs.deleteConfirm')}\n\n${spec.title}`)) return;
    await window.marudesk.invoke('specs:delete', { id: spec.id });
    setSpecs((cur) => (cur ?? []).filter((s) => s.id !== spec.id));
  };

  const sendToAgent = async (spec: Spec): Promise<void> => {
    await focusOrOpenAgentTab();
    const open = spec.tasks.filter((t2) => !t2.done).map((t2) => `- [ ] ${t2.text}`).join('\n');
    const prompt = [
      `${t('specs.agentPreamble')}: ${spec.title}`,
      spec.body.trim(),
      open ? `${t('specs.openTasks')}:\n${open}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const res = await submitPrompt(prompt);
    if (!res.ok && res.reason && res.reason !== 'busy') {
      toast({ title: t('specs.sendFailed'), description: res.reason, variant: 'error' });
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void create()}
        className="flex items-center justify-center gap-1.5 h-8 rounded border border-default text-body-sm text-fg-secondary hover:text-accent hover:border-accent transition-colors duration-fast"
      >
        <Plus size={14} /> {t('specs.new')}
      </button>

      {specs && specs.length === 0 ? (
        <div className="chrome-panel-strong rounded-lg p-4 text-body-sm text-fg-tertiary">
          {t('specs.empty')}
        </div>
      ) : null}

      {(specs ?? []).map((spec) => {
        const expanded = openId === spec.id;
        return (
          <div key={spec.id} className="rounded border border-subtle bg-surface-2">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <button
                type="button"
                onClick={() => setOpenId(expanded ? null : spec.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className="min-w-0 flex-1 truncate text-body-sm text-fg-primary">{spec.title}</span>
                {spec.tasks.length > 0 ? (
                  <span className="shrink-0 text-caption tabular-nums text-fg-tertiary">
                    {taskProgress(spec.tasks)}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                onClick={() => void persist({ ...spec, status: nextStatus(spec.status) })}
                title={t('specs.statusTitle')}
                className={cn('shrink-0 rounded-pill px-1.5 text-caption font-medium', STATUS_CLASS[spec.status])}
              >
                {t(`specs.status.${spec.status}`)}
              </button>
              <button
                type="button"
                onClick={() => void sendToAgent(spec)}
                title={t('specs.sendTitle')}
                className="shrink-0 rounded p-1 text-fg-tertiary hover:text-accent transition-colors duration-fast"
              >
                <SendHorizontal size={13} />
              </button>
              <button
                type="button"
                onClick={() => void remove(spec)}
                title={t('specs.delete')}
                className="shrink-0 rounded p-1 text-fg-tertiary hover:text-error transition-colors duration-fast"
              >
                <Trash2 size={13} />
              </button>
            </div>

            {expanded ? (
              <div className="flex flex-col gap-2 border-t border-subtle p-2">
                <input
                  defaultValue={spec.title}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== spec.title) void persist({ ...spec, title: v });
                  }}
                  placeholder={t('specs.titlePlaceholder')}
                  className="w-full rounded bg-surface-page border border-default px-2 py-1 text-body-sm font-medium text-fg-primary focus:outline-none focus:border-accent"
                />
                <textarea
                  defaultValue={spec.body}
                  onBlur={(e) => {
                    if (e.target.value !== spec.body) void persist({ ...spec, body: e.target.value });
                  }}
                  rows={3}
                  placeholder={t('specs.bodyPlaceholder')}
                  className="w-full resize-y rounded bg-surface-page border border-default px-2 py-1.5 text-body-sm text-fg-primary focus:outline-none focus:border-accent"
                />
                <ul className="flex flex-col gap-0.5">
                  {spec.tasks.map((task) => (
                    <li key={task.id} className="group flex items-center gap-2 text-body-sm">
                      <button
                        type="button"
                        onClick={() =>
                          void persist({
                            ...spec,
                            tasks: spec.tasks.map((x) => (x.id === task.id ? { ...x, done: !x.done } : x)),
                          })
                        }
                        className="shrink-0 text-fg-tertiary hover:text-accent"
                      >
                        {task.done ? <Check size={13} className="text-success" /> : <Square size={13} />}
                      </button>
                      <span className={task.done ? 'flex-1 text-fg-tertiary line-through' : 'flex-1 text-fg-secondary'}>
                        {task.text}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          void persist({ ...spec, tasks: spec.tasks.filter((x) => x.id !== task.id) })
                        }
                        className="shrink-0 rounded p-0.5 text-fg-tertiary opacity-0 hover:text-error group-hover:opacity-100"
                      >
                        <X size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
                <input
                  value={openId === spec.id ? newTask : ''}
                  onChange={(e) => setNewTask(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newTask.trim()) {
                      e.preventDefault();
                      const task: SpecTask = {
                        id: `task-${Date.now().toString(36)}`,
                        text: newTask.trim(),
                        done: false,
                      };
                      void persist({ ...spec, tasks: [...spec.tasks, task] });
                      setNewTask('');
                    }
                  }}
                  placeholder={t('specs.addTask')}
                  className="w-full rounded bg-surface-page border border-default px-2 py-1 text-body-sm text-fg-primary focus:outline-none focus:border-accent"
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
