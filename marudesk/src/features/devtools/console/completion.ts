import { cdpSend, cdpTry } from '../cdp';
import type { RemoteObject } from '../types';

/* ── Console autocomplete helpers ─────────────────────────────────────────── */

/** Chrome's Command Line API helpers, offered as static global candidates. */
export const COMMAND_LINE_API: readonly string[] = [
  '$_',
  '$0',
  '$1',
  '$2',
  '$3',
  '$4',
  '$',
  '$$',
  '$x',
  'inspect',
  'copy',
  'getEventListeners',
  'monitorEvents',
  'unmonitorEvents',
  'monitor',
  'unmonitor',
  'debug',
  'undebug',
  'keys',
  'values',
  'clear',
  'dir',
  'dirxml',
  'table',
  'queryObjects',
  'profile',
  'profileEnd',
];

const COMPLETION_GROUP = 'completion';
/** Cap the candidate list so a huge global scope can't blow up the dropdown. */
export const MAX_COMPLETIONS = 50;

type CompletionContext =
  | { kind: 'member'; receiver: string; prefix: string }
  | { kind: 'global'; prefix: string };

/** A JS identifier-start / -part test (ASCII subset — enough for completion). */
function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

/**
 * Classify what's being typed at `caret`. Only the text BEFORE the caret matters.
 * Walks back over an identifier fragment to its start; if the char before the
 * fragment is `.` (or a `[` with a bare identifier after it), the token before
 * that operator is the receiver to evaluate, and we're completing a member.
 * Otherwise it's a bare-identifier (global) completion. Returns null when there's
 * nothing completable (e.g. caret right after whitespace with no fragment and no
 * preceding `.`), so the caller can clear the popup.
 */
export function parseCompletionContext(
  input: string,
  caret: number,
  force: boolean,
): CompletionContext | null {
  const upto = input.slice(0, Math.max(0, caret));
  // The fragment = trailing run of identifier chars (may be empty, e.g. `foo.`).
  let i = upto.length;
  while (i > 0 && isIdentChar(upto[i - 1])) i--;
  const prefix = upto.slice(i);
  const before = upto.slice(0, i);

  // Member access: `<receiver>.` or `<receiver>[`  (optionally with the fragment
  // already typed). We support the common dot and bare-bracket forms; a bracket
  // with an opening quote (`obj['fo`) is treated as a member too (string key).
  const opMatch = before.match(/(.*?)\s*(\.|\[\s*['"]?)\s*$/s);
  if (opMatch) {
    const receiver = extractReceiver(opMatch[1]);
    if (receiver) return { kind: 'member', receiver, prefix };
  }

  // Global completion: as-you-type only when there's a fragment to complete; a
  // manual trigger (Ctrl+Space) lists everything even on an empty token.
  if (prefix.length === 0 && !force) return null;
  return { kind: 'global', prefix };
}

/**
 * From the text left of a `.`/`[`, pull the receiver expression to evaluate.
 * Handles trailing call/index chains (`a.b().c[0].` → `a.b().c[0]`) by scanning
 * back while brackets are balanced and the run looks like a property/call chain.
 * Bails (returns null) on anything that doesn't end in an identifier, `)`, or `]`
 * — evaluating those would be pointless or unsafe.
 */
function extractReceiver(left: string): string | null {
  const s = left.replace(/\s+$/, '');
  if (!s) return null;
  const last = s[s.length - 1];
  if (!isIdentChar(last) && last !== ')' && last !== ']') return null;
  let i = s.length;
  let depth = 0;
  while (i > 0) {
    const c = s[i - 1];
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && !isIdentChar(c) && c !== '.') {
      break;
    }
    i--;
  }
  const receiver = s.slice(i).trim();
  return receiver.length > 0 ? receiver : null;
}

/**
 * Evaluate the receiver and collect property names down its prototype chain
 * (so inherited members like array/DOM methods appear). Side-effect-free + scoped
 * to a disposable objectGroup, released at the end. Returns [] on any failure.
 */
export async function memberCompletions(tabId: string, receiver: string): Promise<string[]> {
  try {
    const ev = await cdpSend<{ result: RemoteObject; exceptionDetails?: unknown }>(
      tabId,
      'Runtime.evaluate',
      {
        expression: receiver,
        objectGroup: COMPLETION_GROUP,
        includeCommandLineAPI: true,
        throwOnSideEffect: true,
        returnByValue: false,
      },
    );
    if (ev.exceptionDetails || !ev.result) return [];
    const obj = ev.result;
    const names = new Set<string>();

    if (obj.objectId) {
      // Walk own + inherited enumerable/non-enumerable names. accessorPropertiesOnly
      // off → data props; generatePreview off → cheaper.
      const res = await cdpTry<{
        result: { name: string; symbol?: unknown }[];
        internalProperties?: unknown;
      }>(tabId, 'Runtime.getProperties', {
        objectId: obj.objectId,
        ownProperties: false,
        generatePreview: false,
      });
      for (const p of res?.result ?? []) {
        if (typeof p.name === 'string' && !p.symbol) names.add(p.name);
      }
    } else if (obj.type === 'string') {
      // Primitive string: offer String.prototype members via a boxed lookup.
      const res = await cdpTry<{ result: RemoteObject }>(tabId, 'Runtime.evaluate', {
        expression: 'String.prototype',
        objectGroup: COMPLETION_GROUP,
        returnByValue: false,
      });
      const pid = res?.result.objectId;
      if (pid) {
        const props = await cdpTry<{ result: { name: string }[] }>(
          tabId,
          'Runtime.getProperties',
          { objectId: pid, ownProperties: false, generatePreview: false },
        );
        for (const p of props?.result ?? []) names.add(p.name);
      }
    }
    return [...names];
  } catch {
    return [];
  } finally {
    void cdpTry(tabId, 'Runtime.releaseObjectGroup', { objectGroup: COMPLETION_GROUP });
  }
}

/** Own + inherited enumerable property names of the global object. */
export async function globalObjectProperties(tabId: string): Promise<string[]> {
  const ev = await cdpTry<{ result: RemoteObject }>(tabId, 'Runtime.evaluate', {
    expression: 'globalThis',
    objectGroup: COMPLETION_GROUP,
    returnByValue: false,
  });
  const objectId = ev?.result.objectId;
  if (!objectId) return [];
  const res = await cdpTry<{ result: { name: string; symbol?: unknown }[] }>(
    tabId,
    'Runtime.getProperties',
    { objectId, ownProperties: false, generatePreview: false },
  );
  void cdpTry(tabId, 'Runtime.releaseObjectGroup', { objectGroup: COMPLETION_GROUP });
  const names: string[] = [];
  for (const p of res?.result ?? []) {
    if (typeof p.name === 'string' && !p.symbol) names.push(p.name);
  }
  return names;
}

/** Drop duplicate texts, keeping the first (highest-priority) kind seen. */
export function dedupe(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  const out: CompletionItem[] = [];
  for (const it of items) {
    if (seen.has(it.text)) continue;
    seen.add(it.text);
    out.push(it);
  }
  return out;
}

/**
 * Filter candidates by `prefix` and rank them: case-sensitive prefix matches
 * first, then case-insensitive prefix, then case-insensitive substring; ties
 * broken by shorter text then lexicographically. An empty prefix returns the
 * list as-is (capped) so an explicit trigger after `obj.` lists everything.
 */
export function rankCompletions(prefix: string, items: CompletionItem[]): CompletionResult {
  if (!prefix) return { prefix, items: items.slice(0, MAX_COMPLETIONS) };
  const p = prefix;
  const lower = p.toLowerCase();
  const scored: { it: CompletionItem; score: number }[] = [];
  for (const it of items) {
    const t = it.text;
    let score: number;
    if (t.startsWith(p)) score = 0;
    else if (t.toLowerCase().startsWith(lower)) score = 1;
    else if (t.toLowerCase().includes(lower)) score = 2;
    else continue;
    scored.push({ it, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.it.text.length !== b.it.text.length) return a.it.text.length - b.it.text.length;
    return a.it.text < b.it.text ? -1 : a.it.text > b.it.text ? 1 : 0;
  });
  return { prefix, items: scored.slice(0, MAX_COMPLETIONS).map((s) => s.it) };
}

/* ── Console autocomplete ─────────────────────────────────────────────────
 * The kind drives the candidate row's tint/icon; it does not affect ranking. */
export type CompletionKind =
  | 'property' // member of the evaluated receiver
  | 'global' // window / globalThis property or lexical scope name
  | 'command-api' // Command Line API helper ($0, $$, inspect, …)
  | 'history'; // a prior REPL command (prefixed `>` in the UI)

/**
 * `replace` says what accepting the item rewrites:
 * - `token`: the typed token slice `[caret - prefix.length, caret)` (identifiers,
 *   members, Command Line API helpers).
 * - `all`: the ENTIRE input (history entries — a recalled full command line).
 */
export type CompletionItem = {
  text: string;
  kind: CompletionKind;
  replace: 'token' | 'all';
};

/**
 * One completion pass. `prefix` is the partial token the token-kind candidates
 * complete (the substring from the token start to the caret); its input range is
 * `[caret - prefix.length, caret)`. `items` are already filtered + ranked.
 */
export type CompletionResult = { prefix: string; items: CompletionItem[] };
