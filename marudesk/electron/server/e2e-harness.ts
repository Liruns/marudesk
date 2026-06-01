import assert from 'node:assert/strict';
import {
  b64urlToBytes,
  bytesToB64url,
  decodeQrPayload,
  deriveSessionKey,
  encodeQrPayload,
  generateKeyPair,
  makePairProof,
  open,
  reqAad,
  resAad,
  seal,
  SSE_AAD,
  verifyPairProof,
  type QrPayload,
} from '../../shared/e2e.ts';

/**
 * Headless harness for the E2E crypto core (docs/t2-secure-pairing-design.md §2/§3).
 * Runs the SAME shared/e2e.ts the PC and the mobile WebView use, on this node's
 * Web Crypto, with no Electron (run via `node --experimental-strip-types`, see
 * package.json `harness:e2e`). It simulates a full pairing handshake between two
 * fresh X25519 keypairs and asserts both the happy path AND the adversarial paths
 * that matter for E2E:
 *   (a) PC and phone independently derive the SAME key → envelopes interoperate;
 *   (b) the pairing proof verifies only under the right key + code;
 *   (c) tampering, AAD mismatch (wrong endpoint/direction), and a third party's key
 *       all fail to open — i.e. confidentiality + authentication actually hold;
 *   (d) the QR codec round-trips and rejects garbage.
 */

async function main(): Promise<void> {
  let passed = 0;
  const check = (label: string, cond: boolean): void => {
    assert.ok(cond, label);
    passed += 1;
    console.log(`  ok ${passed} - ${label}`);
  };
  const throws = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    let threw = false;
    try {
      await fn();
    } catch {
      threw = true;
    }
    check(label, threw);
  };

  // base64url round-trips arbitrary bytes (incl. high bytes / lengths not %4).
  for (const len of [0, 1, 2, 3, 16, 31, 32, 100]) {
    const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
    const back = b64urlToBytes(bytesToB64url(bytes));
    assert.deepEqual([...back], [...bytes], `b64url round-trip len=${len}`);
  }
  check('base64url round-trips arbitrary byte lengths', true);

  // ── the pairing handshake ────────────────────────────────────────────────
  const code = 'ABCD2345';
  const pc = await generateKeyPair();
  const phone = await generateKeyPair();

  // PC builds the QR (its PUBLIC key only); phone scans + decodes it.
  const qr: QrPayload = {
    v: 1,
    code,
    pcPub: bytesToB64url(pc.publicKeyRaw),
    urls: [{ label: 'Tailscale', url: 'http://100.100.100.100:8787' }],
    name: 'My PC',
    exp: 9_999_999_999_999,
  };
  const scanned = decodeQrPayload(encodeQrPayload(qr));
  check('QR payload round-trips through encode/decode', scanned !== null && scanned.code === code);
  check('decodeQrPayload rejects garbage', decodeQrPayload('not-a-qr@@@') === null);
  check(
    'decodeQrPayload rejects a wrong version',
    decodeQrPayload(encodeQrPayload({ ...qr, v: 2 as 1 })) === null,
  );

  // Both sides derive a session key from their own private + the peer's public.
  const phoneKey = await deriveSessionKey(phone.privateKey, b64urlToBytes(scanned!.pcPub), code);
  const pcKey = await deriveSessionKey(pc.privateKey, phone.publicKeyRaw, code);

  // (a) The two independently-derived keys are the SAME secret: seal on one side,
  //     open on the other, both directions.
  const ph2pc = await seal(phoneKey, { hello: 'from-phone' }, reqAad('POST', '/agent/send'));
  assert.deepEqual(await open(pcKey, ph2pc, reqAad('POST', '/agent/send')), { hello: 'from-phone' });
  const pc2ph = await seal(pcKey, { ok: true, turnId: 't1' }, resAad('/agent/send'));
  assert.deepEqual(await open(phoneKey, pc2ph, resAad('/agent/send')), { ok: true, turnId: 't1' });
  check('PC and phone derive the same key → envelopes interoperate both ways', true);

  // SSE frame round-trip under the dedicated stream AAD.
  const frame = await seal(pcKey, { type: 'snapshot', state: { status: 'idle' } }, SSE_AAD);
  assert.deepEqual(await open(phoneKey, frame, SSE_AAD), {
    type: 'snapshot',
    state: { status: 'idle' },
  });
  check('SSE event frame seals/opens under the stream AAD', true);

  // (b) pairing proof: valid under the right key+code; false otherwise.
  const proof = await makePairProof(phoneKey, code);
  check('verifyPairProof accepts a genuine proof', await verifyPairProof(pcKey, code, proof));
  check(
    'verifyPairProof rejects a proof checked under the wrong code',
    !(await verifyPairProof(pcKey, 'WRONGCOD', proof)),
  );

  // A key derived with a DIFFERENT code is a different secret → proof fails.
  const pcKeyWrongCode = await deriveSessionKey(pc.privateKey, phone.publicKeyRaw, 'OTHERCOD');
  check(
    'a key derived under a different code cannot verify the proof',
    !(await verifyPairProof(pcKeyWrongCode, code, proof)),
  );

  // (c) AAD mismatch — an envelope sealed for one endpoint won't open for another.
  await throws('opening a request envelope with the response AAD fails', () =>
    open(pcKey, ph2pc, resAad('/agent/send')),
  );
  await throws('opening a request envelope with a different path AAD fails', () =>
    open(pcKey, ph2pc, reqAad('POST', '/agent/reset')),
  );

  // (c) tampering — flip a ciphertext byte → GCM tag check fails on open.
  const tampered = { ...ph2pc, ct: flipFirstByte(ph2pc.ct) };
  await throws('a tampered ciphertext fails to open (GCM tag)', () =>
    open(pcKey, tampered, reqAad('POST', '/agent/send')),
  );
  const tamperedProof = { ...proof, ct: flipFirstByte(proof.ct) };
  check('verifyPairProof rejects a tampered proof', !(await verifyPairProof(pcKey, code, tamperedProof)));

  // (c) a third party with its OWN keypair derives a different key → can't read.
  const attacker = await generateKeyPair();
  const attackerKey = await deriveSessionKey(attacker.privateKey, pc.publicKeyRaw, code);
  await throws("a third party's key cannot open the PC↔phone envelope", () =>
    open(attackerKey, ph2pc, reqAad('POST', '/agent/send')),
  );

  console.log(`\ne2e crypto harness: ${passed} assertions passed`);
}

/** Flip the first byte of a b64url blob so the decoded ciphertext is corrupted. */
function flipFirstByte(b64url: string): string {
  const bytes = b64urlToBytes(b64url);
  bytes[0] ^= 0xff;
  return bytesToB64url(bytes);
}

main().catch((err) => {
  console.error('e2e crypto harness FAILED:', err);
  process.exitCode = 1;
});
