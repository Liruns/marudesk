import { check, passedCount } from '../harness-kit.ts';
import { parseInstructionRule, ruleAppliesToPath } from './instruction-rules.ts';

/**
 * Harness for glob-scoped instruction rules (SECOND-PASS "Glob-pattern rule
 * matching"). Pure, runs under bare `node --experimental-strip-types`. Asserts:
 * a file with no frontmatter is unconditional; `applies-to` frontmatter (block,
 * inline, and inline-array forms) scopes injection; basename + full-path matching;
 * an empty applies-to scopes to nothing; the body is returned frontmatter-stripped.
 */

/* ── no frontmatter → unconditional ─────────────────────────────────────── */
{
  const rule = parseInstructionRule('# Rules\nAlways do X.');
  check('no frontmatter → appliesTo null', rule.appliesTo === null);
  check('no frontmatter → body verbatim', rule.body === '# Rules\nAlways do X.');
  check('unconditional rule applies to any path', ruleAppliesToPath(rule, 'src/anything.py'));
}

/* ── block-form applies-to ──────────────────────────────────────────────── */
{
  const raw = '---\napplies-to:\n  - "*.ts"\n  - "src/**/*.tsx"\n---\nUse strict TS here.';
  const rule = parseInstructionRule(raw);
  check('block applies-to parses two globs', rule.appliesTo?.length === 2);
  check('body strips the frontmatter', rule.body === 'Use strict TS here.');
  check('matches *.ts by basename', ruleAppliesToPath(rule, 'lib/deep/util.ts'));
  check('matches src/**/*.tsx by full path', ruleAppliesToPath(rule, 'src/ui/Button.tsx'));
  check('does NOT match a .py file', !ruleAppliesToPath(rule, 'src/util.py'));
  check('does NOT match a .tsx outside src/', !ruleAppliesToPath(rule, 'app/Button.tsx'));
}

/* ── inline scalar + inline array forms ─────────────────────────────────── */
{
  const scalar = parseInstructionRule('---\napplies-to: "*.md"\n---\nDoc rules.');
  check('inline scalar applies-to parses', scalar.appliesTo?.length === 1 && ruleAppliesToPath(scalar, 'README.md'));
  const arr = parseInstructionRule('---\napplies-to: ["*.css", "*.scss"]\n---\nStyle rules.');
  check('inline array applies-to parses both', arr.appliesTo?.length === 2);
  check('inline array matches *.scss', ruleAppliesToPath(arr, 'src/theme.scss'));
  check('inline array rejects *.ts', !ruleAppliesToPath(arr, 'src/theme.ts'));
}

/* ── frontmatter without applies-to → unconditional ─────────────────────── */
{
  const rule = parseInstructionRule('---\ntitle: Notes\n---\nBody.');
  check('frontmatter without applies-to → unconditional', rule.appliesTo === null);
  check('body still stripped', rule.body === 'Body.');
}

/* ── empty applies-to scopes to nothing ─────────────────────────────────── */
{
  const rule = parseInstructionRule('---\napplies-to: []\n---\nNever.');
  check('empty applies-to → empty array', rule.appliesTo?.length === 0);
  check('empty applies-to matches no path', !ruleAppliesToPath(rule, 'anything.ts'));
}

/* ── Windows backslash paths normalize ──────────────────────────────────── */
{
  const rule = parseInstructionRule('---\napplies-to: "src/**/*.ts"\n---\nx');
  check('backslash path normalizes for matching', ruleAppliesToPath(rule, 'src\\a\\b.ts'));
}

console.log(`\ninstruction-rules harness: ${passedCount()} checks passed`);
