import { describe, expect, it } from 'vitest';
import { buildStageToolbarScript } from './stage-toolbar';

/**
 * Floating stage toolbar injection script (§3.2). The on-script adds a pill that
 * triggers the inspect picker via the page bridge; the off-script removes it.
 * Pure string builder, so it's unit-testable without a live page.
 */
describe('buildStageToolbarScript', () => {
  it('on: injects a toolbar that calls the inspect bridge', () => {
    const js = buildStageToolbarScript(true);
    expect(js).toContain('__marudesk_stage_toolbar');
    expect(js).toContain('__marudeskBridge');
    expect(js).toContain('startInspect');
    expect(js).toContain('createElement');
  });

  it('off: removes the toolbar element and does not inject', () => {
    const js = buildStageToolbarScript(false);
    expect(js).toContain('__marudesk_stage_toolbar');
    expect(js).toContain('removeChild');
    expect(js).not.toContain('createElement');
    expect(js).not.toContain('startInspect');
  });
});
