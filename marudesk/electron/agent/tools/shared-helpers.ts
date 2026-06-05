import { getTab, type TabRecord } from '../../browser/state';
import { sendCdp } from '../../browser/cdp';
import type { ToolContext } from './types';

/**
 * Helpers shared by the CDP-backed tool families (runtime + interaction). Each
 * resolves/validates the active web tab and runs a single injection-safe
 * `Runtime.evaluate` through the same allowlisted CDP path the rest of the app
 * uses (docs/agentic-chat-design.md §4).
 */

/** Resolve the turn's active tab, throwing a model-readable error when it's not a live web page. */
export function requireTab(ctx: ToolContext): TabRecord {
  if (!ctx.tabId) {
    throw new Error('no active web tab — open a web page so runtime tools have a target');
  }
  const rec = getTab(ctx.tabId);
  if (!rec || rec.kind !== 'web' || !rec.view) {
    throw new Error('the active tab is not a live web page');
  }
  return rec;
}

/** The tab's current origin, or '' when it has none / can't be parsed. */
export function tabOrigin(rec: TabRecord): string {
  try {
    return new URL(rec.view!.webContents.getURL()).origin;
  } catch {
    return '';
  }
}

export type EvalOutcome = { ok: true; value: unknown } | { ok: false; error: string };

/** Evaluate an expression in the page (by-value, awaiting promises), normalizing exceptions. */
export async function evaluate(rec: TabRecord, expression: string): Promise<EvalOutcome> {
  const res = (await sendCdp(rec, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: 5_000,
  })) as {
    result?: { value?: unknown; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (res?.exceptionDetails) {
    const ex = res.exceptionDetails;
    return { ok: false, error: ex.exception?.description || ex.text || 'evaluation threw' };
  }
  return { ok: true, value: res?.result?.value ?? res?.result?.description };
}
