import type { AgentToolInfo } from '../../../shared/agent';
import type { TranslationKey } from '../../i18n/messages';

/**
 * Settings "tool groups" helpers (§3.11) — let the user see and gate the agent's
 * page-acting tools by group. Gating reuses the existing `agent.denyTools` deny
 * list (enforced in the loop), so a group toggle just adds/removes its tool names.
 * Only the runtime / page-acting / system groups are exposed; core file + agent
 * tools are intentionally not gateable here.
 */

export const RUNTIME_GROUPS = ['browser', 'devtools', 'terminal', 'web'] as const;
export type RuntimeGroup = (typeof RUNTIME_GROUPS)[number];

export const GROUP_LABEL_KEY: Record<RuntimeGroup, TranslationKey> = {
  browser: 'settings.agent.toolGroups.browser',
  devtools: 'settings.agent.toolGroups.devtools',
  terminal: 'settings.agent.toolGroups.terminal',
  web: 'settings.agent.toolGroups.web',
};

export function toolsInGroup(tools: readonly AgentToolInfo[], group: string): string[] {
  return tools.filter((t) => t.group === group).map((t) => t.name);
}

/** A group is "enabled" when none of its tools are on the deny list. */
export function isGroupEnabled(denyTools: readonly string[], names: readonly string[]): boolean {
  if (names.length === 0) return true;
  return names.every((n) => !denyTools.includes(n));
}

/** The deny list after enabling (remove the group's names) or disabling (add them). */
export function applyGroupToggle(
  denyTools: readonly string[],
  names: readonly string[],
  enable: boolean,
): string[] {
  if (enable) return denyTools.filter((n) => !names.includes(n));
  const set = new Set(denyTools);
  for (const n of names) set.add(n);
  return [...set];
}
