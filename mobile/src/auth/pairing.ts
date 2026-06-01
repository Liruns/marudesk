import {
  b64urlToBytes,
  bytesToB64url,
  decodeQrPayload,
  deriveSharedSecret,
  generateKeyPair,
  importAesKey,
  makePairProof,
  open,
  resAad,
  type Envelope,
} from '../lib/e2e';
import type { DirectCreds } from '../transport/types';

/**
 * Run the device-pairing handshake against a PC bridge (docs/t2-secure-pairing-design
 * §2). Given a scanned (or pasted) QR string + a device name: derive the shared key
 * (X25519 → HKDF), prove possession, and POST `/pair` to each candidate URL until one
 * ANSWERS — the design's "try the addresses, keep the first that connects". On the PC
 * the user must approve; on success the sealed `{ deviceId }` comes back and we return
 * the {@link DirectCreds} the DirectTransport needs. Throws a human-readable error.
 */
export async function runPairing(qrString: string, deviceName: string): Promise<DirectCreds> {
  const payload = decodeQrPayload(qrString.trim());
  if (!payload) throw new Error('That isn’t a valid marudesk pairing QR.');
  if (payload.exp < Date.now()) {
    throw new Error('This pairing code expired — regenerate it on your PC.');
  }

  const phone = await generateKeyPair();
  const pcPub = b64urlToBytes(payload.pcPub);
  const keyBytes = await deriveSharedSecret(phone.privateKey, pcPub, payload.code);
  const key = await importAesKey(keyBytes);
  const proof = await makePairProof(key, payload.code);
  const body = JSON.stringify({
    code: payload.code,
    phPub: bytesToB64url(phone.publicKeyRaw),
    deviceName,
    proof,
  });

  let lastNetErr: Error | null = null;
  for (const cand of payload.urls) {
    let res: Response;
    try {
      res = await fetch(`${cand.url}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch (err) {
      // Couldn't reach this address — try the next one.
      lastNetErr = err instanceof Error ? err : new Error(String(err));
      continue;
    }
    // Reached the PC at this address: this candidate decides the outcome.
    if (res.status === 200) {
      const sealed = (await res.json()) as Envelope;
      const result = (await open(key, sealed, resAad('/pair'))) as { deviceId: string };
      return { baseUrl: cand.url, deviceId: result.deviceId, keyB64: bytesToB64url(keyBytes) };
    }
    let message = `Pairing failed (HTTP ${res.status}).`;
    try {
      const j = (await res.json()) as { error?: string };
      if (typeof j.error === 'string') message = j.error;
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new Error(message);
  }

  throw new Error(
    lastNetErr
      ? `Couldn’t reach your PC (${lastNetErr.message}). Same Wi-Fi, or Tailscale up on both?`
      : 'The QR had no addresses to connect to.',
  );
}
