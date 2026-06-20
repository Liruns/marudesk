import { check, passedCount } from '../harness-kit.ts';
import {
  splitDiffByFile,
  capMappedFiles,
  buildMapPrompt,
  buildReducePrompt,
  parseCommitSuggestion,
  formatSuggestionText,
  MAX_MAPPED_FILES,
  MAX_FILE_DIFF_CHARS,
  type FileSummary,
} from './commit-suggest-core.ts';

/**
 * Harness for the pure commit/changelog map-reduce core (SECOND-PASS item 3).
 * Pure + dependency-free — runs standalone under `node --experimental-strip-types`.
 *
 * Covers diff splitting (per-file boundaries + path extraction + rename + delete),
 * the byte-truncation + file-cap bounds, the map/reduce prompt shapes, and the
 * reduce-output parsing (type normalization, header assembly, changelog fallback).
 */

/**
 * Local first-JSON-object extractor — mirrors run-task's `firstJsonObject` but
 * inlined so this harness stays bare (run-task.ts pulls in Electron-bound git /
 * diagnostics modules that don't resolve under plain --experimental-strip-types).
 */
function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  const end = text.lastIndexOf('}');
  if (end < start) return null;
  try {
    const v: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* ── splitDiffByFile ──────────────────────────────────────────────────────── */
{
  check('empty diff → no files', splitDiffByFile('').length === 0);
  check('whitespace diff → no files', splitDiffByFile('   \n  ').length === 0);

  const diff = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 111..222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,2 +1,3 @@',
    '+const x = 1;',
    'diff --git a/README.md b/README.md',
    'index 333..444 100644',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1 +1,2 @@',
    '+docs',
  ].join('\n');
  const files = splitDiffByFile(diff);
  check('splits two files', files.length === 2);
  check('first path is src/app.ts', files[0].path === 'src/app.ts');
  check('second path is README.md', files[1].path === 'README.md');
  check('each chunk keeps its diff --git header', files[0].diff.startsWith('diff --git a/src/app.ts'));
  check('chunks are not truncated when small', !files[0].truncated && !files[1].truncated);

  // A rename: the b/-path is the new name.
  const rename = [
    'diff --git a/old/name.ts b/new/name.ts',
    'similarity index 100%',
    'rename from old/name.ts',
    'rename to new/name.ts',
  ].join('\n');
  check('rename uses the new (b/) path', splitDiffByFile(rename)[0].path === 'new/name.ts');

  // A deletion still parses (path from the a/ side; +++ is /dev/null).
  const del = [
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-was here',
  ].join('\n');
  check('deletion parses its path', splitDiffByFile(del)[0].path === 'gone.ts');
}

/* ── truncation + file cap ────────────────────────────────────────────────── */
{
  const big = 'diff --git a/huge.ts b/huge.ts\n+++ b/huge.ts\n' + 'x'.repeat(MAX_FILE_DIFF_CHARS + 500);
  const [file] = splitDiffByFile(big);
  check('oversized file diff is flagged truncated', file.truncated);
  check('oversized file diff is clipped', file.diff.length <= MAX_FILE_DIFF_CHARS + 64);
  check('truncation note is present', file.diff.includes('diff truncated'));

  // Build N+3 files; the cap keeps N and reports 3 omitted.
  const many = Array.from({ length: MAX_MAPPED_FILES + 3 }, (_v, i) =>
    `diff --git a/f${i}.ts b/f${i}.ts\n+++ b/f${i}.ts\n@@ -0,0 +1 @@\n+line`,
  ).join('\n');
  const split = splitDiffByFile(many);
  check('all files split out before the cap', split.length === MAX_MAPPED_FILES + 3);
  const { mapped, omitted } = capMappedFiles(split);
  check('cap keeps MAX_MAPPED_FILES', mapped.length === MAX_MAPPED_FILES);
  check('cap reports the omitted count', omitted === 3);
  check('under the cap omits nothing', capMappedFiles(split.slice(0, 2)).omitted === 0);
}

/* ── prompt shapes ────────────────────────────────────────────────────────── */
{
  const mapPrompt = buildMapPrompt({ path: 'src/a.ts', diff: 'diff --git…', truncated: false });
  check('map prompt names the file', mapPrompt.includes('`src/a.ts`'));
  check('map prompt asks for one sentence', /ONE terse sentence/i.test(mapPrompt));

  const summaries: FileSummary[] = [
    { path: 'src/a.ts', summary: 'add a flag' },
    { path: 'src/b.ts', summary: 'thread the flag through' },
  ];
  const reduce = buildReducePrompt(summaries, 0);
  check('reduce lists each file summary', reduce.includes('`src/a.ts`: add a flag'));
  check('reduce asks for JSON', reduce.includes('"subject"') && reduce.includes('"changelog"'));
  check('no omitted note when omitted=0', !reduce.includes('not individually summarized'));
  check('omitted note appears when omitted>0', buildReducePrompt(summaries, 4).includes('4 additional file'));
}

/* ── reduce-output parsing ────────────────────────────────────────────────── */
{
  const json = `Here you go:
{"type":"feat","scope":"export","subject":"add self-contained HTML export.","body":"Renders tool calls inline.","changelog":"- Add HTML transcript export"}`;
  const s = parseCommitSuggestion(firstJsonObject(json));
  check('parses a well-formed suggestion', s !== null);
  if (s) {
    check('type preserved', s.type === 'feat');
    check('scope preserved', s.scope === 'export');
    check('subject trimmed + trailing period stripped', s.subject === 'add self-contained HTML export');
    check('header assembled as type(scope): subject', s.message.startsWith('feat(export): add self-contained HTML export'));
    check('body folded into the message', s.message.includes('Renders tool calls inline.'));
    check('changelog leading dash stripped', s.changelog === 'Add HTML transcript export');
    check('formatted text shows the message + changelog', formatSuggestionText(s).includes('Suggested commit message'));
  }

  // Unknown type → defaults to chore; no scope → bare header; changelog falls back to subject.
  const odd = parseCommitSuggestion(firstJsonObject('{"type":"wat","subject":"tidy things","changelog":""}'));
  check('unknown type defaults to chore', odd?.type === 'chore');
  check('no scope → bare header', odd?.message.startsWith('chore: tidy things') === true);
  check('empty changelog falls back to subject', odd?.changelog === 'tidy things');

  // No subject → unusable → null.
  check('missing subject → null', parseCommitSuggestion(firstJsonObject('{"type":"fix"}')) === null);
  check('null input → null', parseCommitSuggestion(null) === null);
}

console.log(`\n${passedCount()} checks passed`);
