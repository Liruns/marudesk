import { useEffect, useState } from 'react';
import type { AgentToolInfo } from '../../../shared/agent';
import { useI18n } from '../../i18n/useI18n';
import { Segmented } from './SettingsControls';
import { useSettingsStore } from './store';
import {
  GROUP_LABEL_KEY,
  RUNTIME_GROUPS,
  applyGroupToggle,
  isGroupEnabled,
  toolsInGroup,
} from './tool-groups';

/**
 * Settings tool-groups panel (§3.11): the agent's page-acting tool groups
 * (browser / devtools / terminal / web) shown as visible, toggleable rows. Each
 * row lists the exact tools in the group and an on/off switch that gates the
 * whole group via the existing `agent.denyTools` deny list — so users can see and
 * cut off the page/system-acting tools without typing tool names. The free-form
 * deny-list field below remains for per-tool control.
 */
export function AgentToolGroups() {
  const { t } = useI18n();
  const denyTools = useSettingsStore((s) => s.settings.agent.denyTools);
  const update = useSettingsStore((s) => s.update);
  const [tools, setTools] = useState<AgentToolInfo[] | null>(null);

  useEffect(() => {
    let alive = true;
    void window.marudesk
      .invoke('agent:list-tools')
      .then((list) => {
        if (alive) setTools(list);
      })
      .catch(() => {
        if (alive) setTools([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!tools) return null;

  const onOff = [
    { value: 'on', label: t('settings.agent.option.on') },
    { value: 'off', label: t('settings.agent.option.off') },
  ] as const;

  return (
    <div className="flex flex-col">
      {RUNTIME_GROUPS.map((group) => {
        const names = toolsInGroup(tools, group);
        if (names.length === 0) return null;
        const enabled = isGroupEnabled(denyTools, names);
        return (
          <div
            key={group}
            className="flex items-center justify-between gap-2 border-b border-subtle px-4 py-2 last:border-0"
          >
            <div className="min-w-0">
              <div className="text-body-sm text-fg-primary">{t(GROUP_LABEL_KEY[group])}</div>
              <div className="truncate font-mono text-caption text-fg-tertiary" title={names.join(', ')}>
                {names.join(', ')}
              </div>
            </div>
            <Segmented
              value={enabled ? 'on' : 'off'}
              options={onOff}
              onChange={(v) =>
                void update({ agent: { denyTools: applyGroupToggle(denyTools, names, v === 'on') } })
              }
            />
          </div>
        );
      })}
    </div>
  );
}
