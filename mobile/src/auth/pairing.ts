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
 *
 * `extraUrl` is an optional user-supplied base URL (a self-hosted tunnel such as
 * cloudflared/ngrok in front of the PC bridge) tried before the QR candidates. All
 * candidates ride along in {@link DirectCreds.urls} (the answering one first) so the
 * transport can fail over to another address when the phone changes networks.
 */
export async function runPairing(
  qrString: string,
  deviceName: string,
  extraUrl?: string,
): Promise<DirectCreds> {
  // A pasted payload survives copy-mangling: strip ALL whitespace (line wraps
  // from chat apps / terminals) before decoding — base64url never contains any.
  const compact = qrString.replace(/\s+/g, '');
  const payload = decodeQrPayload(compact);
  if (!payload) {
    // The most common dead end: the user typed the short on-screen check code
    // instead of the full pairing payload. Name the fix instead of a generic error.
    if (looksLikeShortCode(compact)) {
      throw new Error(
        'That looks like the short check code — it can’t pair on its own. ' +
          'On the PC, use “Copy pairing code” under the QR and paste the full code here.',
      );
    }
    throw new Error('That isn’t a valid marudesk pairing QR.');
  }
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

  const candidates = candidateUrls(payload.urls, extraUrl);
  let lastNetErr: Error | null = null;
  for (const url of candidates) {
    let res: Response;
    try {
      res = await fetch(`${url}/pair`, {
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
      return {
        baseUrl: url,
        deviceId: result.deviceId,
        keyB64: bytesToB64url(keyBytes),
        // The answering URL first, then the rest — the transport's failover order.
        urls: [url, ...candidates.filter((u) => u !== url)],
      };
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

/**
 * Heuristic for "the user pasted the 8-character code shown beside the QR, not
 * the payload": short, and made only of the PC's no-ambiguity code alphabet
 * (A–Z without I/L/O, digits 2–9), case-insensitive, dashes/spaces tolerated.
 * A real payload is base64url JSON — hundreds of characters.
 */
export function looksLikeShortCode(compact: string): boolean {
  const bare = compact.replace(/-/g, '');
  return bare.length > 0 && bare.length <= 16 && /^[a-hj-km-np-z2-9]+$/i.test(bare);
}

/**
 * The ordered, de-duplicated base URLs to try: the user's tunnel URL (if any)
 * first — it's the one address they explicitly chose — then the QR candidates.
 * Trailing slashes are stripped so `${url}/pair` style joins stay valid.
 */
function candidateUrls(qrUrls: readonly { url: string }[], extraUrl?: string): string[] {
  const out: string[] = [];
  const push = (raw: string): void => {
    const url = raw.trim().replace(/\/+$/, '');
    if (url.length > 0 && !out.includes(url)) out.push(url);
  };
  if (extraUrl) push(extraUrl);
  for (const cand of qrUrls) push(cand.url);
  return out;
}
