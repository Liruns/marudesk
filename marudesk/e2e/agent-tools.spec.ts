import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Settings tool-groups catalog (docs/runtime-agent-absorption-2026-06.md §3.11).
 * The settings UI lists the agent's page-acting tools by group via
 * agent:list-tools and gates them through agent.denyTools. Verify the IPC
 * projects the registry (browser/devtools/terminal/web groups with flags).
 */
test('agent:list-tools projects the built-in runtime tool groups', async () => {
  const { app, page } = await launchApp();
  try {
    const tools = await page.evaluate(() => window.marudesk.invoke('agent:list-tools'));
    const byName = new Map(tools.map((t) => [t.name, t]));

    // Browser/page-acting tools present and grouped.
    expect(byName.get('click')?.group).toBe('browser');
    expect(byName.get('eval_js')).toMatchObject({ group: 'browser', gated: true, requiresWeb: true });
    // Other runtime groups the settings panel exposes.
    expect(byName.get('run_command')?.group).toBe('terminal');
    expect(byName.get('get_console_errors')?.group).toBe('devtools');

    const groups = new Set(tools.map((t) => t.group));
    for (const g of ['browser', 'devtools', 'terminal', 'web']) {
      expect(groups.has(g)).toBe(true);
    }
  } finally {
    await app.close();
  }
});
