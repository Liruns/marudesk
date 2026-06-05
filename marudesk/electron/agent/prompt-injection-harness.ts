import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { keywordModePreamble, wantsDeepThinking } from './keyword-modes';
import { claimNestedInstructions, clearNestedInstructionClaims } from './nested-instructions';
import { expandInstructionImports } from './instruction-imports';
import { buildEnvironmentContext } from './environment';

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

  console.log('instruction-imports:');

  const iroot = await fs.mkdtemp(path.join(os.tmpdir(), 'omd-import-'));
  try {
    await fs.mkdir(path.join(iroot, 'docs'), { recursive: true });
    await fs.writeFile(path.join(iroot, 'AGENTS.md'), '# real rules\nbe careful');
    await fs.writeFile(path.join(iroot, 'CLAUDE.md'), '@AGENTS.md'); // our repo's pattern
    await fs.writeFile(path.join(iroot, 'docs', 'git.md'), 'use rebase');
    await fs.writeFile(path.join(iroot, 'chain-a.md'), 'A then @chain-b.md');
    await fs.writeFile(path.join(iroot, 'chain-b.md'), 'B end');
    await fs.writeFile(path.join(iroot, 'cycle-a.md'), 'A @cycle-b.md');
    await fs.writeFile(path.join(iroot, 'cycle-b.md'), 'B @cycle-a.md');

    await check('@import inlines a sibling file (CLAUDE.md → @AGENTS.md)', async () => {
      const abs = path.join(iroot, 'CLAUDE.md');
      const out = await expandInstructionImports('@AGENTS.md', abs, iroot);
      assert.ok(out.includes('real rules'), 'imported content present');
      assert.ok(!out.includes('@AGENTS.md'), 'token replaced');
    });

    await check('nested @imports expand recursively', async () => {
      const abs = path.join(iroot, 'chain-a.md');
      const out = await expandInstructionImports('A then @chain-b.md', abs, iroot);
      assert.ok(out.includes('B end'));
    });

    await check('import cycle terminates without dupe blowup', async () => {
      const abs = path.join(iroot, 'cycle-a.md');
      const out = await expandInstructionImports('A @cycle-b.md', abs, iroot);
      assert.ok(out.includes('A') && out.includes('B'));
    });

    await check('out-of-root / home import is left as literal text', async () => {
      const abs = path.join(iroot, 'AGENTS.md');
      assert.equal(await expandInstructionImports('see @~/.ssh/id_rsa', abs, iroot), 'see @~/.ssh/id_rsa');
      assert.equal(await expandInstructionImports('see @../escape.md', abs, iroot), 'see @../escape.md');
    });

    await check('ordinary @mentions are not clobbered', async () => {
      const abs = path.join(iroot, 'AGENTS.md');
      const text = 'ping @teammate and use @scope/pkg';
      assert.equal(await expandInstructionImports(text, abs, iroot), text);
    });
  } finally {
    await fs.rm(iroot, { recursive: true, force: true });
  }

  console.log('environment:');

  await check('environment block always carries a date + platform', async () => {
    const block = await buildEnvironmentContext(null);
    assert.ok(block.includes('<environment>') && block.includes("Today's date:"));
    assert.ok(block.includes('Platform:'));
    assert.ok(block.includes('none open'), 'no-workspace note');
  });

  await check('environment block reports git state for a repo', async () => {
    const groot = await fs.mkdtemp(path.join(os.tmpdir(), 'omd-env-'));
    try {
      const block = await buildEnvironmentContext({ root: groot });
      assert.ok(block.includes(`Workspace root: ${groot}`));
      assert.ok(block.includes('Git:'), 'has a git line (repo or not)');
    } finally {
      await fs.rm(groot, { recursive: true, force: true });
    }
  });

  console.log(process.exitCode ? '\nFAILED' : '\nAll checks passed.');
}

void main();
