import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { isModeClear, modePreamble, modeRaisesThinking, modesInPrompt } from './keyword-modes';
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
  // Mirror the loop's sticky-mode resolution so we can test persistence here.
  function resolveSticky(prev: string[], prompt: string): string[] {
    if (isModeClear(prompt)) return [];
    const added = modesInPrompt(prompt);
    return added.length > 0 ? [...new Set([...prev, ...added])] : prev;
  }

  console.log('keyword-modes:');

  await check('no keyword → no modes, null preamble', () => {
    assert.deepEqual(modesInPrompt('please fix the login bug'), []);
    assert.equal(modePreamble([]), null);
    assert.equal(modeRaisesThinking([]), false);
  });

  await check('ulw triggers ultrawork', () => {
    assert.deepEqual(modesInPrompt('ulw refactor the parser'), ['ultrawork']);
    assert.ok(modePreamble(['ultrawork'])?.includes('Ultrawork mode'));
  });

  await check('multiple modes accumulate (ultrathink + ulw)', () => {
    const ids = modesInPrompt('ultrathink and ulw on this');
    assert.ok(ids.includes('think') && ids.includes('ultrawork'));
    const p = modePreamble(ids)!;
    assert.ok(p.includes('Deep-thinking mode') && p.includes('Ultrawork mode'));
    assert.equal(modeRaisesThinking(ids), true);
  });

  await check('search / analyze phrases trigger their modes', () => {
    assert.deepEqual(modesInPrompt('deep search for callers'), ['search']);
    assert.deepEqual(modesInPrompt('deep analysis of the loop'), ['analyze']);
  });

  await check('keywords inside code fences do NOT trigger', () => {
    assert.deepEqual(modesInPrompt('see `ulw` in the snippet'), []);
    assert.deepEqual(modesInPrompt('```\nultrathink\n```\nwhat is this?'), []);
  });

  await check('bare common words do not misfire', () => {
    assert.deepEqual(modesInPrompt('search the docs and think about it'), []);
  });

  await check('modes are sticky across turns until cleared', () => {
    let active: string[] = [];
    active = resolveSticky(active, 'ulw build the feature');
    assert.deepEqual(active, ['ultrawork']);
    // A later plain message keeps the mode active (no re-typing needed).
    active = resolveSticky(active, 'now wire up the button');
    assert.deepEqual(active, ['ultrawork']);
    // Adding another mode stacks it.
    active = resolveSticky(active, 'ultrathink about the edge cases');
    assert.ok(active.includes('ultrawork') && active.includes('think'));
    // "mode off" clears everything, and a clear message does not re-add.
    active = resolveSticky(active, 'mode off, just answer briefly');
    assert.deepEqual(active, []);
    active = resolveSticky(active, 'stop ultrawork');
    assert.deepEqual(active, []);
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

    await check('AGENTS.override.md wins over AGENTS.md', async () => {
      await fs.writeFile(path.join(root, 'pkg', 'AGENTS.override.md'), '# pkg override wins');
      clearNestedInstructionClaims();
      const block = await claimNestedInstructions(root, 'pkg/app.ts');
      assert.ok(block.includes('pkg/AGENTS.override.md') && block.includes('pkg override wins'));
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
