import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { keywordModePreamble, wantsDeepThinking } from './keyword-modes';
import { claimNestedInstructions, clearNestedInstructionClaims } from './nested-instructions';

/**
 * Standalone runtime checks for the prompt-injection logic (no Electron deps):
 *   node --experimental-strip-types electron/agent/prompt-injection-harness.ts
 * Covers keyword-mode accumulation + deep-think detection and the on-demand
 * nested instruction walk + conversation-scoped claim set.
 */

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch((err) => {
      console.error(`FAIL  ${name}\n      ${(err as Error).message}`);
      process.exitCode = 1;
    });
}

async function main(): Promise<void> {
  console.log('keyword-modes:');

  await check('no keyword → null preamble, no deep-think', () => {
    assert.equal(keywordModePreamble('please fix the login bug'), null);
    assert.equal(wantsDeepThinking('please fix the login bug'), false);
  });

  await check('ulw triggers ultrawork', () => {
    const p = keywordModePreamble('ulw refactor the parser');
    assert.ok(p && p.includes('Ultrawork mode'));
  });

  await check('multiple modes accumulate (ultrathink + ulw)', () => {
    const p = keywordModePreamble('ultrathink and ulw on this');
    assert.ok(p && p.includes('Deep-thinking mode'), 'has think');
    assert.ok(p && p.includes('Ultrawork mode'), 'has ultrawork');
    assert.equal(wantsDeepThinking('ultrathink and ulw on this'), true);
  });

  await check('search / analyze phrases trigger their modes', () => {
    assert.ok(keywordModePreamble('deep search for callers')?.includes('Search mode'));
    assert.ok(keywordModePreamble('deep analysis of the loop')?.includes('Analyze mode'));
  });

  await check('keywords inside code fences do NOT trigger', () => {
    assert.equal(keywordModePreamble('see `ulw` in the snippet'), null);
    assert.equal(keywordModePreamble('```\nultrathink\n```\nwhat is this?'), null);
  });

  await check('bare common words do not misfire', () => {
    assert.equal(keywordModePreamble('search the docs and think about it'), null);
  });

  console.log('nested-instructions:');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omd-nested-'));
  try {
    await fs.mkdir(path.join(root, 'pkg', 'sub'), { recursive: true });
    await fs.writeFile(path.join(root, 'AGENTS.md'), '# root (handled up-front)');
    await fs.writeFile(path.join(root, 'pkg', 'AGENTS.md'), '# pkg rules');
    await fs.writeFile(path.join(root, 'pkg', 'sub', 'CLAUDE.md'), '# sub rules');

    await check('walks subdirs nearest-first, excludes root', async () => {
      clearNestedInstructionClaims();
      const block = await claimNestedInstructions(root, 'pkg/sub/app.ts');
      assert.ok(block.includes('pkg/sub/CLAUDE.md'), 'sub injected');
      assert.ok(block.includes('pkg/AGENTS.md'), 'pkg injected');
      assert.ok(!block.includes('root (handled up-front)'), 'root excluded');
      // nearest-first ordering
      assert.ok(block.indexOf('pkg/sub') < block.indexOf('pkg/AGENTS.md'));
    });

    await check('claim set dedupes within a conversation', async () => {
      clearNestedInstructionClaims();
      await claimNestedInstructions(root, 'pkg/sub/app.ts');
      const again = await claimNestedInstructions(root, 'pkg/sub/other.ts');
      assert.equal(again, '', 'nothing new the second time');
    });

    await check('clear re-enables injection', async () => {
      clearNestedInstructionClaims();
      const block = await claimNestedInstructions(root, 'pkg/sub/app.ts');
      assert.ok(block.length > 0);
    });

    await check('root-level file injects nothing', async () => {
      clearNestedInstructionClaims();
      assert.equal(await claimNestedInstructions(root, 'top.ts'), '');
    });

    await check('AGENTS.md beats CLAUDE.md in the same dir', async () => {
      await fs.writeFile(path.join(root, 'pkg', 'CLAUDE.md'), '# pkg claude (should be ignored)');
      clearNestedInstructionClaims();
      const block = await claimNestedInstructions(root, 'pkg/app.ts');
      assert.ok(block.includes('pkg/AGENTS.md'), 'AGENTS chosen');
      assert.ok(!block.includes('pkg claude (should be ignored)'), 'CLAUDE skipped');
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log(process.exitCode ? '\nFAILED' : '\nAll checks passed.');
}

void main();
