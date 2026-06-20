import { check, passedCount } from '../harness-kit.ts';
import { dedupInstructionSources } from './instructions-dedup.ts';

/**
 * Harness for SECOND-PASS item 7 (instruction-paragraph dedup). PURE: the dedup
 * helper does no I/O and lives in its own dependency-free module, so this runs
 * under a bare `node --experimental-strip-types` harness.
 */

/* ── A duplicate paragraph in a LATER source is dropped (first wins) ─────── */

{
  const shared = 'Always run the typecheck before claiming a change is complete.';
  const [a, b] = dedupInstructionSources([
    `(AGENTS.md)\n\n${shared}`,
    `(~/.claude/CLAUDE.md)\n\n${shared}`,
  ]);
  check('first source keeps the shared paragraph', a.includes(shared));
  check('later source drops the duplicate paragraph', !b.includes(shared));
  check('later source keeps its own framing header', b.includes('~/.claude/CLAUDE.md'));
}

/* ── Normalization: whitespace + case differences still dedup ────────────── */

{
  const [, b] = dedupInstructionSources([
    'Prefer the smallest change that preserves existing package boundaries.',
    'PREFER the   smallest change   that preserves existing package boundaries.',
  ]);
  check('case/whitespace-variant duplicate is dropped', b.trim() === '');
}

/* ── Short blocks (headers, separators) are NEVER dropped ────────────────── */

{
  const [a, b] = dedupInstructionSources(['# Rules', '# Rules']);
  check('short header survives in source A', a === '# Rules');
  check('short header is NOT deduped in source B (below the substance threshold)', b === '# Rules');
}

/* ── Non-duplicate paragraphs are all preserved ─────────────────────────── */

{
  const src1 = 'Use rg for search and rg --files for file discovery in this repo.';
  const src2 = 'Keep unrelated worktree changes intact and never revert user edits.';
  const [a, b] = dedupInstructionSources([src1, src2]);
  check('distinct paragraph 1 preserved', a.includes('rg for search'));
  check('distinct paragraph 2 preserved', b.includes('worktree changes intact'));
}

/* ── Mixed block: only the duplicate paragraph is removed, others survive ── */

{
  const dup = 'TypeScript stays strict — avoid any, suppression comments, and broad casts.';
  const unique = 'Verify changes from the package that owns the behavior before finishing.';
  const [, b] = dedupInstructionSources([
    `(AGENTS.md)\n\n${dup}`,
    `(settings)\n\n${dup}\n\n${unique}`,
  ]);
  check('duplicate paragraph removed from the second source', !b.includes('TypeScript stays strict'));
  check('unique paragraph in the second source survives', b.includes('Verify changes from the package'));
}

/* ── Empty / no-instruction path is byte-identical ──────────────────────── */

{
  const out = dedupInstructionSources(['', '', '']);
  check('all-empty input passes through unchanged', out.length === 3 && out.every((s) => s === ''));
}

/* ── A paragraph repeated WITHIN one source is also collapsed ────────────── */

{
  const line = 'Run the relevant typecheck and exercise the real UI surface when practical.';
  const [a] = dedupInstructionSources([`${line}\n\n${line}`]);
  const occurrences = a.split(line).length - 1;
  check('intra-source duplicate paragraph collapsed to one', occurrences === 1);
}

console.log(`\n${passedCount()} checks passed`);
