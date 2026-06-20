/**
 * Glob-scoped instruction rules (SECOND-PASS "Glob-pattern rule matching").
 *
 * marudesk's {@link ./nested-instructions.ts} injects a directory's AGENTS.md /
 * CLAUDE.md whenever a tool touches a path under that directory — flat, by
 * location only. This adds an OPTIONAL per-file-type scope: an instruction file
 * may open with a tiny YAML-ish frontmatter block declaring `applies-to` globs,
 * and is then injected ONLY when the touched path matches one of them. A file with
 * no frontmatter is unconditional, exactly as today — so this composes cleanly
 * and changes nothing for existing repos.
 *
 *   ---
 *   applies-to:
 *     - "*.ts"
 *     - "src/**\/*.tsx"
 *   ---
 *   Use the repo's strict-TS conventions for these files…
 *
 * (single-line `applies-to: "*.ts"` and a `[a, b]` inline list are also accepted.)
 *
 * Pure + dependency-light (reuses {@link import('../../shared/glob').globToRegExp},
 * a tiny MIT-style matcher already in the repo). No Electron imports, so it loads
 * under the plain `--experimental-strip-types` harness; relative value imports use
 * an explicit `.ts` extension.
 */
import { globToRegExp } from '../../shared/glob.ts';

export type InstructionRule = {
  /**
   * Glob patterns the rule applies to (workspace-relative, forward slashes), or
   * null when the file has no `applies-to` frontmatter — meaning "always apply".
   */
  readonly appliesTo: readonly string[] | null;
  /** The instruction body with the frontmatter block stripped. */
  readonly body: string;
};

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Split an instruction file into its (optional) `applies-to` globs and the body
 * with the frontmatter removed. A file without a leading `---` block parses to
 * `{ appliesTo: null, body: <verbatim> }` (unconditional, today's behavior). A
 * frontmatter block WITHOUT an `applies-to` key also yields `null` (the other
 * keys, if any, are ignored — only `applies-to` is meaningful here).
 */
export function parseInstructionRule(raw: string): InstructionRule {
  const m = FRONTMATTER.exec(raw);
  if (!m) return { appliesTo: null, body: raw };
  const body = raw.slice(m[0].length);
  const globs = parseAppliesTo(m[1]);
  return { appliesTo: globs, body };
}

/**
 * Extract the `applies-to` globs from a frontmatter block. Supports:
 *   applies-to: "*.ts"
 *   applies-to: ["*.ts", "*.tsx"]
 *   applies-to:
 *     - "*.ts"
 *     - src/**\/*.tsx
 * Returns null when the key is absent, or an empty array when present but empty
 * (an explicit empty `applies-to` scopes the rule to NOTHING — it never injects).
 */
function parseAppliesTo(frontmatter: string): readonly string[] | null {
  const lines = frontmatter.split(/\r?\n/);
  let i = lines.findIndex((l) => /^applies-to\s*:/.test(l.trim()));
  if (i === -1) return null;

  const head = lines[i].trim().replace(/^applies-to\s*:/, '').trim();
  const out: string[] = [];

  // Inline forms: `applies-to: "*.ts"` or `applies-to: [a, b]`.
  if (head) {
    if (head.startsWith('[') && head.endsWith(']')) {
      for (const part of head.slice(1, -1).split(',')) {
        const g = unquote(part.trim());
        if (g) out.push(g);
      }
    } else {
      const g = unquote(head);
      if (g) out.push(g);
    }
    return out;
  }

  // Block form: subsequent `  - <glob>` lines until the indentation/dash run ends.
  for (i += 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t === '') continue;
    if (!t.startsWith('-')) break; // next key / end of the list
    const g = unquote(t.slice(1).trim());
    if (g) out.push(g);
  }
  return out;
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Whether a rule applies to a workspace-relative path. `appliesTo === null` ⇒
 * always (unconditional file). Otherwise the path matches a glob if EITHER the
 * full relative path or its basename matches — so a bare `*.ts` scopes by
 * extension regardless of directory depth, while `src/**` scopes by location.
 * Backslashes are normalized to forward slashes first (Windows paths).
 */
export function ruleAppliesToPath(rule: InstructionRule, relPath: string): boolean {
  if (rule.appliesTo === null) return true;
  if (rule.appliesTo.length === 0) return false;
  const norm = relPath.replace(/\\/g, '/');
  const base = norm.split('/').pop() ?? norm;
  return rule.appliesTo.some((glob) => {
    const re = globToRegExp(glob);
    return re.test(norm) || re.test(base);
  });
}
