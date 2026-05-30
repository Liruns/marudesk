/**
 * Adapter: a selected CDP DOM node → a {@link Capture} for the AI composer
 * context (integration hook A, §9). The legacy inspect overlay built captures
 * in the page via `getBoundingClientRect`/`textContent`; here the node lives in
 * the main process behind CDP, so we assemble the same shape from `DOM.*`
 * results plus the computed style the Elements panel already loaded — and add
 * the richer `outerHTML`/`computedStyle` fields the flat overlay capture lacked.
 *
 * Pure helpers are exported for unit-testability; `buildCapture` does the two
 * CDP round-trips (`DOM.getOuterHTML`, `DOM.getBoxModel`) and is tolerant of
 * either failing (a detached/navigating page) — it degrades to empty fields
 * rather than throwing, so "Add to context" never hard-fails.
 */

import type {
  CaptureRect,
  ConsoleErrorCapture,
  ElementCapture,
} from '../../../shared/capture';
import { cdpTry } from './cdp';
import {
  NODE_TYPE,
  type CdpNode,
  type ComputedStyleProperty,
  type ConsoleEntry,
  type NodeId,
  type RemoteObject,
} from './types';

/** Bounded so a huge subtree can't bloat the capture / LLM payload. */
const MAX_OUTER_HTML = 8_000;
const MAX_TEXT = 120;
const MAX_SELECTOR_DEPTH = 5;
/** Bound a single computed value (e.g. an inlined `url(data:…)` background). */
const MAX_COMPUTED_VALUE = 200;

/**
 * High-signal computed properties (box / layout / typography / colour). CDP
 * returns ~all longhands; we keep this curated subset so the composer context
 * stays legible. Only keys actually present are copied.
 */
const COMPUTED_KEYS: readonly string[] = [
  'display',
  'position',
  'width',
  'height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'text-align',
  'flex-direction',
  'justify-content',
  'align-items',
  'gap',
  'border-radius',
  'box-sizing',
  'z-index',
  'opacity',
];
const COMPUTED_KEY_SET = new Set(COMPUTED_KEYS);

let seq = 0;
function captureId(): string {
  return `dtcap-${Date.now().toString(36)}-${++seq}`;
}

/** CDP's flat `[name, value, name, value, …]` attribute array → a record. */
export function attrsToRecord(attributes: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attributes) return out;
  for (let i = 0; i < attributes.length; i += 2) {
    out[attributes[i]] = attributes[i + 1] ?? '';
  }
  return out;
}

function nodeSegment(node: CdpNode): string {
  const tag = node.localName || node.nodeName.toLowerCase();
  const attrs = attrsToRecord(node.attributes);
  if (attrs.id) return `${tag}#${attrs.id}`;
  const cls = attrs.class?.trim().split(/\s+/).filter(Boolean)[0];
  if (cls) return `${tag}.${cls}`;
  return tag;
}

/**
 * A compact, readable selector path built from whatever ancestry is indexed in
 * the store (best-effort — the lazy DOM tree may not have every ancestor). Not
 * guaranteed unique; it's for display + LLM legibility, not requerying (ranking
 * keys off `attributes`, not this).
 */
export function buildNodeSelector(nodeId: NodeId, nodes: Map<NodeId, CdpNode>): string {
  const parts: string[] = [];
  let cur: CdpNode | undefined = nodes.get(nodeId);
  let depth = 0;
  while (cur && cur.nodeType === NODE_TYPE.ELEMENT && depth < MAX_SELECTOR_DEPTH) {
    parts.unshift(nodeSegment(cur));
    if (cur.parentId === undefined) break;
    const parent = nodes.get(cur.parentId);
    if (!parent || parent.nodeType !== NODE_TYPE.ELEMENT) break; // reached <html>/document
    cur = parent;
    depth++;
  }
  return parts.join(' > ');
}

/** Curate the full computed-style list down to the high-signal subset. */
export function curateComputed(
  computed: ComputedStyleProperty[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of computed) {
    if (COMPUTED_KEY_SET.has(name) && value) {
      out[name] =
        value.length > MAX_COMPUTED_VALUE ? value.slice(0, MAX_COMPUTED_VALUE) + '…' : value;
    }
  }
  return out;
}

/** Crudely strip tags for a short text snippet (display + ranking keywords). */
function stripToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

/** Border-box rect from CDP's border quad `[x1,y1,x2,y2,x3,y3,x4,y4]`. */
function rectFromQuad(border: number[] | undefined): CaptureRect {
  if (!border || border.length < 8) return { x: 0, y: 0, width: 0, height: 0 };
  const [x1, y1, x2, , , , , y4] = border;
  return {
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.round(x2 - x1),
    height: Math.round(y4 - y1),
  };
}

export async function buildCapture(
  tabId: string,
  nodeId: NodeId,
  node: CdpNode,
  nodes: Map<NodeId, CdpNode>,
  computed: ComputedStyleProperty[],
  url: string,
): Promise<ElementCapture> {
  const [outer, box] = await Promise.all([
    cdpTry<{ outerHTML: string }>(tabId, 'DOM.getOuterHTML', { nodeId }),
    cdpTry<{ model: { border: number[]; width: number; height: number } }>(
      tabId,
      'DOM.getBoxModel',
      { nodeId },
    ),
  ]);
  const rawHtml = outer?.outerHTML ?? '';
  const computedStyle = curateComputed(computed);
  return {
    kind: 'element',
    id: captureId(),
    timestamp: Date.now(),
    url,
    selector: buildNodeSelector(nodeId, nodes),
    tagName: node.localName || node.nodeName.toLowerCase(),
    text: stripToText(rawHtml),
    attributes: attrsToRecord(node.attributes),
    rect: rectFromQuad(box?.model.border),
    outerHTML: rawHtml
      ? rawHtml.length > MAX_OUTER_HTML
        ? rawHtml.slice(0, MAX_OUTER_HTML) + '\n<!-- …truncated -->'
        : rawHtml
      : undefined,
    computedStyle: Object.keys(computedStyle).length > 0 ? computedStyle : undefined,
  };
}

/** A console RemoteObject → short text (mirrors ConsolePanel's display logic). */
function remoteObjText(o: RemoteObject): string {
  if (o.value !== undefined) return String(o.value);
  return o.description ?? o.unserializableValue ?? o.className ?? o.type;
}

/**
 * Adapter: a console error/exception entry → a {@link ConsoleErrorCapture} for
 * the AI composer ("Fix this", §9). Pure — the entry already holds the message,
 * stack, and location (from main's always-on extraction). `url` is the page URL
 * (origin for deterministic stack→source resolution in electron/llm.ts).
 */
export function consoleEntryToErrorCapture(
  entry: ConsoleEntry,
  url: string,
): ConsoleErrorCapture {
  const joined =
    entry.text && entry.text.length > 0
      ? entry.text
      : entry.args.map(remoteObjText).filter(Boolean).join(' ');
  // First line only (the full stack lives in `stack`) — matches the first-line
  // normalization main's extractConsoleError applies, so a seeded vs. live
  // capture of the same error yields the same message.
  const message = (joined.split('\n')[0] || '(error)').slice(0, 1000);
  const stack = entry.stackTrace?.callFrames ?? [];
  const top = stack.find((f) => f.url);
  const source = entry.url
    ? { url: entry.url, lineNumber: entry.lineNumber }
    : top
      ? { url: top.url, lineNumber: top.lineNumber }
      : undefined;
  return {
    kind: 'console-error',
    id: captureId(),
    timestamp: entry.timestamp,
    url,
    message,
    stack,
    source,
  };
}
