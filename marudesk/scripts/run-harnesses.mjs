/**
 * Unified headless-harness runner (`npm run harness:all`).
 *
 * Auto-discovers every `harness:*` script in package.json and runs them
 * SEQUENTIALLY (several harnesses bind localhost ports, so parallel runs would
 * collide), buffering each one's output and printing a single summary at the
 * end. A new harness script is picked up automatically — no edit here needed;
 * a harness that must not run by default goes in SKIP with a reason.
 *
 * Usage:
 *   node scripts/run-harnesses.mjs                 # run the full curated list
 *   node scripts/run-harnesses.mjs --only mcp,pair # substring filter
 *   node scripts/run-harnesses.mjs --list          # print the list and exit
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG_ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

/** Scripts excluded from the default run, with the reason shown in --list. */
const SKIP = new Map([
  ['harness:media-gen', 'alias of harness:image-gen (same entry file)'],
]);

/** Wall-clock cap per harness; a hung harness must not wedge the whole run. */
const HARNESS_TIMEOUT_MS = 240_000;

function discover() {
  const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  return Object.keys(pkg.scripts ?? {})
    .filter((name) => name.startsWith('harness:') && name !== 'harness:all')
    .sort();
}

function parseArgs(argv) {
  const args = { only: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') args.list = true;
    else if (argv[i] === '--only') args.only = (argv[++i] ?? '').split(',').filter(Boolean);
  }
  return args;
}

/** Run one npm script; resolves { code, output, ms, timedOut }. Never rejects. */
function runScript(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    // shell:true so `npm` resolves to npm.cmd on Windows; the tree-kill below
    // handles the extra shell layer on timeout.
    const child = spawn(`npm run -s ${name}`, { cwd: PKG_ROOT, shell: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        // Kill the whole tree (cmd -> npm -> node); child.kill only hits cmd.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false });
      } else {
        child.kill('SIGKILL');
      }
    }, HARNESS_TIMEOUT_MS);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? 'timeout' : code ?? 'killed',
        output: Buffer.concat(chunks).toString('utf8'),
        ms: Date.now() - started,
        timedOut,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 'spawn-error', output: String(err), ms: Date.now() - started, timedOut });
    });
  });
}

const fmtMs = (ms) => `${(ms / 1000).toFixed(1)}s`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = discover();
  const selected = all.filter((name) => {
    if (SKIP.has(name)) return false;
    if (args.only) return args.only.some((needle) => name.includes(needle));
    return true;
  });

  if (args.list) {
    for (const name of all) {
      const skip = SKIP.get(name);
      console.log(skip ? `  skip ${name} — ${skip}` : `  run  ${name}`);
    }
    return;
  }
  if (selected.length === 0) {
    console.error(`no harness matches --only ${args.only?.join(',')}`);
    process.exitCode = 1;
    return;
  }

  console.log(`running ${selected.length} harness(es) sequentially…\n`);
  const failures = [];
  const startedAll = Date.now();
  for (const name of selected) {
    process.stdout.write(`  ${name} … `);
    const res = await runScript(name);
    if (res.code === 0) {
      console.log(`ok (${fmtMs(res.ms)})`);
    } else {
      console.log(`FAIL (exit ${res.code}, ${fmtMs(res.ms)})`);
      failures.push({ name, ...res });
    }
  }

  console.log(`\n${selected.length - failures.length}/${selected.length} harnesses passed (${fmtMs(Date.now() - startedAll)})`);
  for (const f of failures) {
    const tail = f.output.split(/\r?\n/).filter(Boolean).slice(-40).join('\n');
    console.log(`\n--- ${f.name} (exit ${f.code}) — last output ---\n${tail}`);
  }
  if (failures.length > 0) process.exitCode = 1;
}

await main();
