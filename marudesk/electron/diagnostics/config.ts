import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../fs-safe';
import type { Diagnostic, DiagnosticSeverity } from '../../shared/diagnostics';
import {
  CHECKERS,
  PARSERS,
  toRel,
  type CheckerRecipe,
  type ParseFn,
  type ParserId,
} from './checkers';

/**
 * External checker recipes (docs/workspace-language-support-design.md, Tier 1 L2).
 * marudesk does NOT own the list of languages: built-in recipes (checkers.ts) are
 * overlaid by user recipes from `userData/languages.json` — same hand-editable,
 * untrusted-file model as mcp-servers.json. A user (or, later, a plugin) adds a
 * language with one entry; the core needs no change.
 *
 * Since the file is untrusted, an external recipe can't ship a JS parser. It
 * either references a built-in parser by name (`parser: "tsc" | "eslint-json"`)
 * or declares a line regex with named groups (file/line/col/severity/message/code).
 * A malformed entry is dropped, never crashes the app. Default is empty → inert.
 */

/** A regex parser declared in languages.json. */
type RegexParseSpec = { regex?: unknown; flags?: unknown; source?: unknown };
/** One raw entry from the file (every field still untrusted). */
type ExternalRecipe = {
  id?: unknown;
  label?: unknown;
  appliesWhen?: unknown;
  command?: unknown;
  parser?: unknown;
  parse?: unknown;
};
type LanguagesFile = { checkers?: unknown };

export function languagesConfigPath(): string {
  return path.join(app.getPath('userData'), 'languages.json');
}

function severityFrom(raw: string | undefined): DiagnosticSeverity {
  const s = (raw ?? '').toLowerCase();
  if (s.startsWith('warn')) return 'warning';
  if (s === 'info' || s === 'note' || s === 'information') return 'info';
  return 'error';
}

/** Compile a declared regex into a line-oriented parser (named groups). */
function buildRegexParser(spec: RegexParseSpec, fallbackSource: string): ParseFn | null {
  if (typeof spec.regex !== 'string' || !spec.regex) return null;
  let re: RegExp;
  try {
    re = new RegExp(spec.regex, typeof spec.flags === 'string' ? spec.flags : '');
  } catch {
    return null; // bad pattern — drop the recipe rather than throw
  }
  const source = typeof spec.source === 'string' && spec.source ? spec.source : fallbackSource;
  return (output, root) => {
    const out: Diagnostic[] = [];
    for (const line of output.split(/\r?\n/)) {
      re.lastIndex = 0;
      const g = re.exec(line)?.groups;
      if (!g || typeof g.file !== 'string' || !g.file) continue;
      out.push({
        file: toRel(g.file, root),
        line: Number(g.line) || 1,
        column: Number(g.col ?? g.column) || 1,
        severity: severityFrom(typeof g.severity === 'string' ? g.severity : undefined),
        code: typeof g.code === 'string' && g.code ? g.code : undefined,
        message: (g.message ?? '').trim(),
        source,
      });
    }
    return out;
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
}

/** Validate + compile one untrusted entry into a recipe, or null to drop it. */
function compile(ext: ExternalRecipe): CheckerRecipe | null {
  if (typeof ext.id !== 'string' || !ext.id.trim()) return null;
  if (!isStringArray(ext.appliesWhen) || ext.appliesWhen.length === 0) return null;
  if (typeof ext.command !== 'string' || !ext.command.trim()) return null;

  let parse: ParseFn | null = null;
  if (typeof ext.parser === 'string' && ext.parser in PARSERS) {
    parse = PARSERS[ext.parser as ParserId];
  } else if (ext.parse && typeof ext.parse === 'object') {
    parse = buildRegexParser(ext.parse as RegexParseSpec, ext.id);
  }
  if (!parse) return null;

  const command = ext.command;
  return {
    id: ext.id,
    label: typeof ext.label === 'string' && ext.label ? ext.label : ext.id,
    appliesWhen: ext.appliesWhen,
    resolveCommand: () => command,
    parse,
  };
}

/** Read + compile user recipes from languages.json (missing/corrupt → none). */
function loadExternalCheckers(): CheckerRecipe[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(languagesConfigPath(), 'utf8'));
  } catch {
    return [];
  }
  const list = raw && typeof raw === 'object' ? (raw as LanguagesFile).checkers : null;
  if (!Array.isArray(list)) return [];
  const out: CheckerRecipe[] = [];
  for (const item of list) {
    if (item && typeof item === 'object') {
      const recipe = compile(item as ExternalRecipe);
      if (recipe) out.push(recipe);
    }
  }
  return out;
}

/**
 * The active recipe set: built-ins overlaid by user recipes (a user entry with
 * the same id overrides the built-in; new ids are added). Re-read each call so an
 * edit to languages.json takes effect on the next diagnostics pass.
 */
export function getActiveCheckers(): CheckerRecipe[] {
  const byId = new Map<string, CheckerRecipe>();
  for (const c of CHECKERS) byId.set(c.id, c);
  for (const c of loadExternalCheckers()) byId.set(c.id, c);
  return [...byId.values()];
}

/** A seeded file with a (disabled) example, so "open config" reveals a real file. */
const TEMPLATE = {
  checkers: [],
  // Move an entry from "example" into "checkers" to enable it. "parser" reuses a
  // built-in ("tsc" | "eslint-json"); "parse.regex" uses named groups
  // (file, line, col, severity, message, code) for any line-oriented checker.
  example: {
    id: 'rust',
    label: 'Rust',
    appliesWhen: ['Cargo.toml'],
    command: 'cargo check --message-format short',
    parse: {
      regex: '^(?<file>[^:\\n]+):(?<line>\\d+):(?<col>\\d+):\\s+(?<severity>error|warning):\\s+(?<message>.*)$',
      source: 'rustc',
    },
  },
};

/** Ensure languages.json exists (seeded), returning its path — for "open config". */
export async function ensureLanguagesConfigFile(): Promise<string> {
  const p = languagesConfigPath();
  try {
    fs.accessSync(p);
  } catch {
    await atomicWriteFile(p, JSON.stringify(TEMPLATE, null, 2)).catch(() => {});
  }
  return p;
}
