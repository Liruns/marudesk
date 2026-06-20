import { check, passedCount } from '../harness-kit.ts';
import { buildHandoffPrompt, assembleHandoffDoc, buildHandoffSeed } from './handoff-doc.ts';
import { HANDOFF_INSTRUCTION, HANDOFF_SEED_PREFIX } from './prompts.ts';

/**
 * Harness for the pure session-handoff assembly (SECOND-PASS item 2). Pure +
 * dependency-free — runs standalone under `node --experimental-strip-types`.
 *
 * Covers the prompt assembly (instruction + conversation framing + optional
 * focus), the document assembly (model brief + appended file manifest, and the
 * no-manifest passthrough), and the fresh-session seed framing.
 */

/* ── prompt assembly ──────────────────────────────────────────────────────── */
{
  const convo = 'user: fix the bug\n\nassistant: [ran read_file]';
  const prompt = buildHandoffPrompt(convo);
  check('prompt carries the handoff instruction', prompt.includes(HANDOFF_INSTRUCTION));
  check('prompt frames the conversation in a <conversation> block', prompt.includes(`<conversation>\n${convo}\n</conversation>`));
  check('prompt has no focus addendum when none given', !prompt.includes('extra detail'));

  const focused = buildHandoffPrompt(convo, '  the migration path  ');
  check('focus is folded in (trimmed)', focused.includes('extra detail: the migration path'));
  check('blank focus is ignored', !buildHandoffPrompt(convo, '   ').includes('extra detail'));
}

/* ── document assembly ────────────────────────────────────────────────────── */
{
  const brief = '  ## Objective\nShip the feature.  ';
  const manifest = '<read-files>\n- src/app.ts\n</read-files>';
  const withManifest = assembleHandoffDoc(brief, manifest);
  check('summary is trimmed', withManifest.summary === '## Objective\nShip the feature.');
  check('manifest appended after a blank line', withManifest.document === `${withManifest.summary}\n\n${manifest}`);

  const noManifest = assembleHandoffDoc(brief, '');
  check('no manifest → document is just the trimmed brief', noManifest.document === noManifest.summary);
  check('no-manifest document has no trailing manifest tags', !noManifest.document.includes('<read-files>'));
}

/* ── fresh-session seed ───────────────────────────────────────────────────── */
{
  const doc = '## Objective\nContinue the port.';
  const seed = buildHandoffSeed(doc);
  check('seed carries the continuation prefix', seed.includes(HANDOFF_SEED_PREFIX));
  check('seed frames the doc in a <handoff> block', seed.includes(`<handoff>\n${doc}\n</handoff>`));
  // The seed must contain the full document so a fresh model has the complete context.
  check('seed contains the whole document', seed.includes(doc));
}

console.log(`\n${passedCount()} checks passed`);
