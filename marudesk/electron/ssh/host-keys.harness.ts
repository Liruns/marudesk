import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, passedCount } from '../harness-kit';
import {
  clearPinnedHostKey,
  evaluateHostKey,
  getPinnedHostKey,
  hostKeyId,
  listPinnedHostKeys,
  parseHostKeyAlgorithm,
  pinHostKey,
  sha256Fingerprint,
} from './host-keys';

/**
 * Headless harness for TOFU host-key pinning (host-keys.ts): first-sight pins,
 * a matching key passes, a CHANGED key is rejected with an actionable error,
 * and the Settings escape hatch (clear) re-arms first-sight. Runs under plain
 * Node (`npm run harness:ssh-host-keys`) — no Electron, no real SSH server;
 * the pure evaluate step is exactly what connection-manager's hostVerifier runs.
 */

/** A fake host-key blob in SSH wire format: uint32 len + algorithm + key bytes. */
function fakeHostKey(algorithm: string, seed: string): Buffer {
  const name = Buffer.from(algorithm, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(name.length, 0);
  return Buffer.concat([len, name, Buffer.from(seed, 'utf8')]);
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-ssh-host-keys-'));
  const file = path.join(dir, 'ssh-known-hosts.json');
  const host = 'devbox.example.com';
  const port = 2222;
  const keyA = fakeHostKey('ssh-ed25519', 'key-material-A');
  const keyB = fakeHostKey('ecdsa-sha2-nistp256', 'key-material-B');

  try {
    // ── pure helpers ────────────────────────────────────────────────────
    check('parses the algorithm out of the wire-format blob', parseHostKeyAlgorithm(keyA) === 'ssh-ed25519');
    check('malformed blob degrades to "unknown" algorithm', parseHostKeyAlgorithm(Buffer.from([1, 2])) === 'unknown');
    const fpA = sha256Fingerprint(keyA);
    check('fingerprint is OpenSSH-style SHA256:base64', /^SHA256:[A-Za-z0-9+/]+$/.test(fpA));
    check('host key id is host:port', hostKeyId(host, port) === 'devbox.example.com:2222');

    // ── id normalization: one host can never be pinned under two spellings ──
    check(
      'host case is normalized (Example.com ≡ example.com)',
      hostKeyId('Example.com', 22) === hostKeyId('example.com', 22),
    );
    check('normalized host id lowercases', hostKeyId('Example.COM', 22) === 'example.com:22');
    check(
      'bracketed vs unbracketed IPv6 collapse to one id',
      hostKeyId('[::1]', 22) === hostKeyId('::1', 22),
    );
    check(
      'bracketed and unbracketed forms of the same IPv6 expansion collapse to one id',
      hostKeyId('[0:0:0:0:0:0:0:1]', 22) === hostKeyId('0:0:0:0:0:0:0:1', 22),
    );
    check('IPv6 case is normalized', hostKeyId('[FE80::1]', 22) === hostKeyId('fe80::1', 22));
    check('IPv6 id keeps the bracket form', hostKeyId('::1', 22) === '[::1]:22');
    check('distinct hosts stay distinct', hostKeyId('a.example.com', 22) !== hostKeyId('b.example.com', 22));
    check('distinct ports stay distinct', hostKeyId('example.com', 22) !== hostKeyId('example.com', 2222));
    check('distinct IPv6 addresses stay distinct', hostKeyId('::1', 22) !== hostKeyId('::2', 22));

    // ── a pin written under one spelling is found under another ──────────────
    await pinHostKey(file, {
      host: '[2001:DB8::1]',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprintSha256: sha256Fingerprint(keyA),
      pinnedAt: 1_750_000_000_001,
    });
    const aliasLookup = await getPinnedHostKey(file, '2001:db8::1', 22);
    check(
      'pin written under one spelling is found under an alternate spelling',
      aliasLookup?.fingerprintSha256 === sha256Fingerprint(keyA),
    );
    check('cleanup the alias pin', (await clearPinnedHostKey(file, '[2001:db8::1]', 22)) === true);

    // ── first sight: nothing pinned → accept + signal pin ───────────────
    const first = evaluateHostKey(undefined, host, port, keyA);
    check('first sight is accepted', first.ok);
    check('first sight is flagged for pinning', first.ok && first.firstSight);
    check(
      'first sight surfaces algorithm + fingerprint to pin',
      first.ok && first.algorithm === 'ssh-ed25519' && first.fingerprintSha256 === fpA,
    );

    // ── pin persists ─────────────────────────────────────────────────────
    if (first.ok) {
      await pinHostKey(file, {
        host,
        port,
        algorithm: first.algorithm,
        fingerprintSha256: first.fingerprintSha256,
        pinnedAt: 1_750_000_000_000,
      });
    }
    const pinned = await getPinnedHostKey(file, host, port);
    check('pin persists to the store file', pinned?.fingerprintSha256 === fpA);
    check('pin keeps the algorithm', pinned?.algorithm === 'ssh-ed25519');
    const listed = await listPinnedHostKeys(file);
    check('list returns the pinned entry', listed.length === 1 && listed[0].host === host && listed[0].port === port);

    // ── later connect, same key → pass (not first sight) ────────────────
    const match = evaluateHostKey(pinned, host, port, keyA);
    check('matching key passes', match.ok);
    check('matching key is not re-flagged as first sight', match.ok && !match.firstSight);

    // ── later connect, CHANGED key → reject with actionable error ───────
    const mismatch = evaluateHostKey(pinned, host, port, keyB);
    check('changed key is rejected', !mismatch.ok);
    if (!mismatch.ok) {
      check('rejection names the host and port', mismatch.error.includes(`${host}:${port}`));
      check('rejection shows the stored fingerprint', mismatch.error.includes(fpA));
      check('rejection shows the offered fingerprint', mismatch.error.includes(sha256Fingerprint(keyB)));
      check(
        'rejection explains how to clear the pin',
        /Settings → Remote → Pinned SSH host keys/.test(mismatch.error),
      );
    }

    // ── clearing the pin re-arms first-sight pinning ─────────────────────
    check('clear removes the pin', (await clearPinnedHostKey(file, host, port)) === true);
    check('clear of a missing pin reports false', (await clearPinnedHostKey(file, host, port)) === false);
    check('nothing pinned after clear', (await getPinnedHostKey(file, host, port)) === undefined);
    const rePinned = evaluateHostKey(await getPinnedHostKey(file, host, port), host, port, keyB);
    check('next connect after clear is first sight again', rePinned.ok && rePinned.firstSight);

    // ── corrupt store degrades to "nothing pinned", never a lockout ──────
    fs.writeFileSync(file, '{not json', 'utf8');
    check('corrupt store lists as empty', (await listPinnedHostKeys(file)).length === 0);
    const afterCorrupt = evaluateHostKey(await getPinnedHostKey(file, host, port), host, port, keyA);
    check('corrupt store falls back to first-sight pinning', afterCorrupt.ok && afterCorrupt.firstSight);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nssh host-key pinning harness: ${passedCount()} assertions passed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
