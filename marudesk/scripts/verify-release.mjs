#!/usr/bin/env node
/**
 * Post-build sanity check: verify the release/ directory contains the platform
 * update manifests (latest.yml / latest-mac.yml / latest-linux.yml) that
 * electron-updater reads from GitHub Releases. Without these files, packaged
 * apps cannot detect or download updates.
 *
 * Usage:
 *   node scripts/verify-release.mjs          # check release/ directory
 *   node scripts/verify-release.mjs --remote # check the latest GitHub release
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const RELEASE_DIR = resolve(import.meta.dirname, '..', 'release');
const MANIFESTS = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];

function checkLocal() {
  let files;
  try {
    files = readdirSync(RELEASE_DIR);
  } catch {
    console.error(`\x1b[31m✗ release/ directory not found. Run a build first.\x1b[0m`);
    process.exit(1);
  }

  const found = MANIFESTS.filter((m) => files.includes(m));
  const exes = files.filter(
    (f) => f.endsWith('.exe') || f.endsWith('.dmg') || f.endsWith('.AppImage') || f.endsWith('.deb'),
  );

  if (found.length === 0) {
    console.error(`\x1b[31m✗ No update manifest found in release/.\x1b[0m`);
    console.error(`  Installers: ${exes.join(', ') || '(none)'}`);
    console.error(`  Expected at least one of: ${MANIFESTS.join(', ')}`);
    console.error(`\n  Use "npm run release:win" (--publish always) instead of "npm run package:win".`);
    process.exit(1);
  }

  console.log(`\x1b[32m✓ Update manifests present: ${found.join(', ')}\x1b[0m`);
  for (const m of found) console.log(`  release/${m}`);
  if (exes.length) console.log(`  Installers: ${exes.join(', ')}`);
}

function checkRemote() {
  let assets;
  try {
    const raw = execSync(
      'gh release view --repo Liruns/marudesk --json assets,tagName --jq "."',
      { encoding: 'utf8', timeout: 15_000 },
    );
    const parsed = JSON.parse(raw);
    assets = parsed.assets.map((a) => a.name);
    console.log(`Checking release ${parsed.tagName}...`);
  } catch (err) {
    console.error(`\x1b[31m✗ Could not fetch latest release from GitHub.\x1b[0m`);
    console.error(String(err));
    process.exit(1);
  }

  const found = MANIFESTS.filter((m) => assets.includes(m));
  if (found.length === 0) {
    console.error(`\x1b[31m✗ No update manifest found in the latest GitHub release.\x1b[0m`);
    console.error(`  Assets: ${assets.join(', ')}`);
    console.error(`\n  Fix: upload the missing manifest, or re-release with "npm run release:win".`);
    process.exit(1);
  }

  console.log(`\x1b[32m✓ Update manifests present: ${found.join(', ')}\x1b[0m`);
}

const remote = process.argv.includes('--remote');
if (remote) checkRemote();
else checkLocal();
