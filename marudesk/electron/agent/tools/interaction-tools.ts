import { scrubText } from '../../../shared/scrub';
import { clipText as clip } from '../../../shared/text-clip';
import type { ToolContext, ToolResult } from './types';
import { requireTab, evaluate } from './shared-helpers';

/**
 * Interaction tools (click / fill / press_key / scroll) — the "agent drives the
 * running app" wedge. Each builds a fixed, injection-safe JS expression (the
 * selector/value/key are JSON-encoded *data*, never spliced as code) and runs it
 * through the SAME Runtime.evaluate path as eval_js — so the CDP allowlist is
 * unchanged (no Input. domain) and the attack surface is identical. All four are
 * gated + write (read-only mode refuses them; ask mode approves per call), and
 * every returned string is scrubbed + clipped.
 */

export async function click(input: { selector?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const selector = typeof input.selector === 'string' ? input.selector : '';
  if (!selector) throw new Error('click requires "selector"');
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true };
  })()`;
  const out = await evaluate(rec, expr);
  if (!out.ok) return { summary: `click ${selector}`, text: `click failed — ${scrubText(out.error)}`, isError: true };
  const v = (out.value ?? {}) as { ok?: boolean };
  if (!v.ok) return { summary: `click ${selector}`, text: `no element matches ${selector}`, isError: true };
  return { summary: `clicked "${selector}"`, text: clip(scrubText(`clicked ${selector}`)) };
}

export async function fill(
  input: { selector?: unknown; value?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const selector = typeof input.selector === 'string' ? input.selector : '';
  if (!selector) throw new Error('fill requires "selector"');
  const value = typeof input.value === 'string' ? input.value : '';
  // React (and other controlled inputs) ignore a plain `el.value =` because they
  // track value via the prototype setter; call the NATIVE setter then dispatch
  // input+change so the framework's onChange fires. contenteditable uses
  // textContent + an input event.
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false };
    const value = ${JSON.stringify(value)};
    el.focus();
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      return { ok: false, unfillable: true };
    }
    return { ok: true };
  })()`;
  const out = await evaluate(rec, expr);
  if (!out.ok) return { summary: `fill ${selector}`, text: `fill failed — ${scrubText(out.error)}`, isError: true };
  const v = (out.value ?? {}) as { ok?: boolean; unfillable?: boolean };
  if (!v.ok) {
    const why = v.unfillable
      ? `${selector} is not an input/textarea/contenteditable`
      : `no element matches ${selector}`;
    return { summary: `fill ${selector}`, text: why, isError: true };
  }
  return { summary: `filled "${selector}"`, text: clip(scrubText(`filled ${selector}`)) };
}

export async function pressKey(
  input: { key?: unknown; selector?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const key = typeof input.key === 'string' ? input.key : '';
  if (!key) throw new Error('press_key requires "key" (e.g. "Enter", "Escape", "Tab", "ArrowDown")');
  const selector = typeof input.selector === 'string' ? input.selector : '';
  // Dispatch a synthetic keydown+keyup on the target (selector element, focused
  // first) or the active element. Good enough for standard key handlers
  // (Enter/Escape/Tab/arrows); not a full trusted-event key press.
  const expr = `(() => {
    const sel = ${JSON.stringify(selector)};
    let el = sel ? document.querySelector(sel) : document.activeElement;
    if (sel) {
      if (!el) return { ok: false };
      el.focus();
    }
    el = el || document.body;
    const key = ${JSON.stringify(key)};
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    return { ok: true };
  })()`;
  const out = await evaluate(rec, expr);
  if (!out.ok) return { summary: `press_key ${key}`, text: `press_key failed — ${scrubText(out.error)}`, isError: true };
  const v = (out.value ?? {}) as { ok?: boolean };
  if (!v.ok) return { summary: `press_key ${key}`, text: `no element matches ${selector}`, isError: true };
  const where = selector ? ` on "${selector}"` : '';
  return { summary: `pressed ${key}${where}`, text: clip(scrubText(`pressed ${key}${where}`)) };
}

export async function scroll(
  input: { selector?: unknown; direction?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const selector = typeof input.selector === 'string' ? input.selector : '';
  const direction = input.direction === 'up' ? 'up' : 'down';
  // Selector → smooth-scroll it into view; otherwise scroll the window a screenful.
  const expr = selector
    ? `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false };
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return { ok: true };
      })()`
    : `(() => {
        window.scrollBy(0, ${direction === 'up' ? -600 : 600});
        return { ok: true };
      })()`;
  const out = await evaluate(rec, expr);
  if (!out.ok) return { summary: 'scroll', text: `scroll failed — ${scrubText(out.error)}`, isError: true };
  const v = (out.value ?? {}) as { ok?: boolean };
  if (!v.ok) return { summary: `scroll ${selector}`, text: `no element matches ${selector}`, isError: true };
  const what = selector ? `scrolled "${selector}" into view` : `scrolled ${direction}`;
  return { summary: what, text: clip(scrubText(what)) };
}
