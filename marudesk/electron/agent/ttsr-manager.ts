import { globToRegExp } from '../../shared/glob.ts';

/**
 * TTSR — Time-Traveling Stream Rules (SECOND-PASS item 6 / gajae ttsr.ts).
 *
 * A PURE, dependency-free mid-stream rule matcher: it buffers the model's
 * streaming output (per source) and reports when a configured dangerous pattern
 * matches — e.g. the model is about to write a protected file, or a
 * prompt-injection signature appears — BEFORE the tool call lands. The intended
 * runtime use is: on a match, abort the stream, re-inject the rule as a reminder,
 * and retry the step.
 *
 * This module is the MATCHER ONLY. The live abort+retry wiring is the
 * edit-safety / transcript-integrity-sensitive part; per the port plan it is
 * deferred and the loop carries only an INERT hook point (loop.ts: ttsr is
 * constructed but `enabled` is false, so checkDelta is a no-op that can't perturb
 * the stream or the transcript). Keeping the matcher pure + fully tested means the
 * risky half can be turned on later behind a flag without touching this logic.
 */

/** Where in the stream a chunk came from — rules can scope to one source. */
export type TtsrSource = 'text' | 'thinking' | 'tool';

/** How often a rule may fire within a turn/session. */
export type TtsrRepeatMode = 'once' | 'always' | 'gap';

/** A configured stream rule: a name, regex conditions, scope, and an injectable reminder. */
export type TtsrRule = {
  name: string;
  /** Regex source strings; ANY match (on its scoped buffer) fires the rule. */
  condition: string[];
  /** The reminder text to re-inject when the rule fires. */
  reminder: string;
  /** Sources this rule watches (default: ['text', 'tool'] — not thinking). */
  scope?: TtsrSource[];
  /** Path globs: when set, a `tool` match only fires if a candidate path matches one. */
  globs?: string[];
};

/** Repeat-gating settings for the manager. */
export type TtsrSettings = {
  enabled?: boolean;
  repeatMode?: TtsrRepeatMode;
  /** For `gap` mode: minimum number of marks between repeats. */
  repeatGap?: number;
};

/** Context describing the stream chunk being checked. */
export type TtsrContext = {
  source: TtsrSource;
  /** Tool name for `source: 'tool'` chunks (e.g. "edit_file"). */
  toolName?: string;
  /** Candidate file paths associated with the chunk (for glob-scoped tool rules). */
  filePaths?: string[];
  /** Stable buffer key (e.g. a tool-call id) to isolate buffering. */
  streamKey?: string;
};

/** A fired rule, ready for the (deferred) inject+retry step. */
export type TtsrMatch = { name: string; reminder: string };

const DEFAULT_SCOPE: readonly TtsrSource[] = ['text', 'tool'];

type CompiledRule = {
  rule: TtsrRule;
  conditions: RegExp[];
  scope: Set<TtsrSource>;
  pathGlobs: RegExp[];
};

/**
 * The mid-stream rule matcher. Stateful across a turn (buffers + injection
 * records) but PURE in the sense that nothing here touches the loop, the
 * transcript, fs, or the network — it only answers "did a configured pattern
 * match this stream so far?". The loop owns whether/how to act on a match.
 */
export class TtsrManager {
  readonly #enabled: boolean;
  readonly #repeatMode: TtsrRepeatMode;
  readonly #repeatGap: number;
  readonly #rules = new Map<string, CompiledRule>();
  readonly #buffers = new Map<string, string>();
  /** rule name → mark index when last injected (repeat gating). */
  readonly #injected = new Map<string, number>();
  #markCount = 0;

  constructor(rules: readonly TtsrRule[] = [], settings: TtsrSettings = {}) {
    this.#enabled = settings.enabled ?? false;
    this.#repeatMode = settings.repeatMode ?? 'once';
    this.#repeatGap = settings.repeatGap ?? 10;
    for (const rule of rules) this.addRule(rule);
  }

  /** Register a rule. Returns false when it has no valid regex condition (skipped). */
  addRule(rule: TtsrRule): boolean {
    if (!rule.name || this.#rules.has(rule.name)) return false;
    const conditions: RegExp[] = [];
    for (const pattern of rule.condition ?? []) {
      try {
        conditions.push(new RegExp(pattern));
      } catch {
        // An invalid regex is skipped, not fatal — a single bad rule can't break the turn.
      }
    }
    if (conditions.length === 0) return false;
    const scope = new Set<TtsrSource>(rule.scope && rule.scope.length > 0 ? rule.scope : DEFAULT_SCOPE);
    const pathGlobs = (rule.globs ?? []).map((g) => g.trim()).filter(Boolean).map((g) => globToRegExp(g));
    this.#rules.set(rule.name, { rule, conditions, scope, pathGlobs });
    return true;
  }

  /** Whether any rules are registered AND the manager is enabled (the live gate). */
  get active(): boolean {
    return this.#enabled && this.#rules.size > 0;
  }

  /**
   * Feed one stream delta and return any rules that now match. When the manager is
   * inert (`enabled: false`) this is a guaranteed no-op returning `[]` — that's the
   * loop's safe hook point. Buffers are isolated per source/tool so a match in
   * assistant prose can't bleed into an unrelated tool-argument stream.
   */
  checkDelta(delta: string, context: TtsrContext): TtsrMatch[] {
    if (!this.active) return [];
    const key = this.#bufferKey(context);
    const buffer = `${this.#buffers.get(key) ?? ''}${delta}`;
    this.#buffers.set(key, buffer);

    const matches: TtsrMatch[] = [];
    for (const [name, compiled] of this.#rules) {
      if (!this.#canFire(name)) continue;
      if (!compiled.scope.has(context.source)) continue;
      if (!this.#matchesPaths(compiled, context)) continue;
      if (!compiled.conditions.some((re) => re.test(buffer))) continue;
      matches.push({ name, reminder: compiled.rule.reminder });
    }
    return matches;
  }

  /** Mark rules as injected so repeat gating applies on subsequent checks. */
  markInjected(names: readonly string[]): void {
    for (const name of names) this.#injected.set(name, this.#markCount);
  }

  /** Advance the repeat-gating clock (call once per turn/step boundary). */
  advanceMark(): void {
    this.#markCount += 1;
  }

  /** Clear per-stream buffers (call at the start of each model step). */
  resetBuffers(): void {
    this.#buffers.clear();
  }

  /** A path-glob rule fires on a tool chunk only when a candidate path matches. */
  #matchesPaths(compiled: CompiledRule, context: TtsrContext): boolean {
    if (compiled.pathGlobs.length === 0) return true;
    if (context.source !== 'tool') return true; // globs only constrain tool streams
    const paths = (context.filePaths ?? []).map((p) => p.replace(/\\/g, '/'));
    if (paths.length === 0) return false;
    return compiled.pathGlobs.some((re) => paths.some((p) => re.test(p) || re.test(basename(p))));
  }

  #canFire(name: string): boolean {
    const last = this.#injected.get(name);
    if (last === undefined) return true;
    if (this.#repeatMode === 'always') return true;
    if (this.#repeatMode === 'once') return false;
    return this.#markCount - last >= this.#repeatGap;
  }

  #bufferKey(context: TtsrContext): string {
    if (context.streamKey && context.streamKey.trim()) return context.streamKey;
    if (context.source !== 'tool') return context.source;
    const tool = context.toolName?.trim().toLowerCase();
    return tool ? `tool:${tool}` : 'tool';
  }
}

/** Basename of a forward-slash path (for matching a glob against the file name alone). */
function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}
