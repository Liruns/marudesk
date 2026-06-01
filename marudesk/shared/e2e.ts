/**
 * End-to-end encryption + pairing handshake for the direct LAN/Tailscale bridge
 * (docs/t2-secure-pairing-design.md). Pure + portable: it touches ONLY the
 * standard Web Crypto API (`globalThis.crypto.subtle` + `getRandomValues`) plus
 * btoa/atob/TextEncoder, so the EXACT SAME module runs in the Electron main
 * process (node ≥ 18 webcrypto) and the mobile Chromium WebView — no node:crypto,
 * no new dependency. (The mobile package keeps a verbatim copy; this file is kept
 * self-contained — no cross-imports — precisely so that copy stays identical.)
 *
 * Scheme (decisions E1–E3 in the design doc): X25519 ECDH for key agreement (the
 * pairing QR carries only the PC's PUBLIC key, so a screenshot/MITM never sees the
 * shared secret), HKDF-SHA256 to derive a per-pairing AES key (salt = the one-time
 * pairing code — same device, fresh key per pairing), and AES-256-GCM with a fresh
 * random 12-byte nonce per message. The AEAD's additional-data (AAD) binds every
 * ciphertext to its context (endpoint / direction) so an envelope can't be lifted
 * and replayed against a different route. Possession of the derived key IS the
 * device's authentication (E4) — there is no separate bearer secret on this path.
 */

export const E2E_VERSION = 1;
/** HKDF context string — bump with any breaking change to the derivation. */
const HKDF_INFO = 'marudesk-e2e-v1';
/** AES-GCM nonce length (bytes). 96-bit random nonces per the GCM recommendation. */
const NONCE_BYTES = 12;
/** AES + HKDF output size (bits). */
const KEY_BITS = 256;

const te = new TextEncoder();
const td = new TextDecoder();

/**
 * WebCrypto's global TYPES (CryptoKey / SubtleCrypto / CryptoKeyPair) aren't
 * declared uniformly across our tsconfigs: the renderer/mobile carry the DOM lib,
 * but the Electron-main project (lib: ES2023 + @types/node) exposes them only as
 * values. So derive what we need from the `globalThis.crypto` VALUE — that
 * resolves identically in node-without-DOM and in the DOM, with no extra lib and
 * no node:crypto import (keeping this file copyable verbatim into mobile).
 */
type Subtle = (typeof globalThis.crypto)['subtle'];
type CryptoKey = Awaited<ReturnType<Subtle['importKey']>>;
type CryptoKeyPair = { publicKey: CryptoKey; privateKey: CryptoKey };

/**
 * UTF-8 encode into an ArrayBuffer-backed view. `TextEncoder.encode()` yields a
 * `Uint8Array<ArrayBufferLike>`, which TS 6 won't accept as WebCrypto's
 * `BufferSource` (it could be SharedArrayBuffer-backed); copying through the
 * `Uint8Array` constructor pins it to a plain ArrayBuffer.
 */
function enc(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(te.encode(s));
}

/* ── base64url (portable: no Buffer, works in node + WebView) ─────────────── */

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/* ── wire types ───────────────────────────────────────────────────────────── */

/** One AEAD message: `n` = b64url(12-byte nonce), `ct` = b64url(ciphertext‖tag). */
export type Envelope = { n: string; ct: string };

/** A reachable base URL (structurally identical to shared/remote.ts ConnectCandidate). */
export type UrlCandidate = { label: string; url: string };

/**
 * What the PC encodes into the pairing QR (shown on the trusted PC screen). Carries
 * the PC's X25519 PUBLIC key only — never the shared secret — plus the one-time
 * code (HKDF salt), the reachable URLs to try, a human PC name, and an expiry.
 */
export type QrPayload = {
  v: typeof E2E_VERSION;
  code: string;
  /** b64url(raw X25519 public key, 32 bytes). */
  pcPub: string;
  urls: UrlCandidate[];
  name: string;
  /** Epoch milliseconds after which the QR is dead. */
  exp: number;
};

/** `POST /pair` body (plaintext; gated by the one-time `code` + a key-possession proof). */
export type PairRequestBody = {
  code: string;
  /** b64url(raw X25519 public key) of the phone. */
  phPub: string;
  deviceName: string;
  /** Proves the phone derived the session key from THIS QR — see {@link makePairProof}. */
  proof: Envelope;
};

/** `POST /pair` success body, returned AEAD-sealed under the freshly-derived key. */
export type PairResultBody = { deviceId: string };

/* ── X25519 key agreement ───────────────────────────────────────────────────── */

function subtle(): Subtle {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Web Crypto (crypto.subtle) is unavailable in this runtime');
  return s;
}

/** Generate an ephemeral X25519 keypair; returns the raw public key bytes + the private CryptoKey. */
export async function generateKeyPair(): Promise<{
  publicKeyRaw: Uint8Array<ArrayBuffer>;
  privateKey: CryptoKey;
}> {
  const kp = (await subtle().generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as unknown as CryptoKeyPair;
  const raw = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
  return { publicKeyRaw: raw, privateKey: kp.privateKey };
}

function importPeerPublic(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return subtle().importKey('raw', raw, { name: 'X25519' }, false, []);
}

/**
 * ECDH(privateKey, peerPublic) → HKDF(salt = code) → AES-256-GCM key. Both sides
 * compute the identical key from their own private key + the peer's public key.
 */
export async function deriveSessionKey(
  privateKey: CryptoKey,
  peerPublicRaw: Uint8Array<ArrayBuffer>,
  code: string,
): Promise<CryptoKey> {
  const peer = await importPeerPublic(peerPublicRaw);
  const shared = await subtle().deriveBits({ name: 'X25519', public: peer }, privateKey, KEY_BITS);
  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const okm = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc(code), info: enc(HKDF_INFO) },
    ikm,
    KEY_BITS,
  );
  return subtle().importKey('raw', okm, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/* ── AEAD envelope ──────────────────────────────────────────────────────────── */

/** Encrypt `obj` (JSON-serialized) under `key`, binding it to `aad`. Fresh random nonce. */
export async function seal(key: CryptoKey, obj: unknown, aad: string): Promise<Envelope> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const pt = enc(JSON.stringify(obj));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc(aad) }, key, pt);
  return { n: bytesToB64url(iv), ct: bytesToB64url(new Uint8Array(ct)) };
}

/**
 * Decrypt + JSON-parse an {@link Envelope}. Throws if the key is wrong, the
 * ciphertext was tampered with, or the `aad` doesn't match the one used to seal —
 * so a caller can treat any throw as "unauthenticated / invalid".
 */
export async function open(key: CryptoKey, env: Envelope, aad: string): Promise<unknown> {
  const iv = b64urlToBytes(env.n);
  const ct = b64urlToBytes(env.ct);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: enc(aad) }, key, ct);
  return JSON.parse(td.decode(new Uint8Array(pt))) as unknown;
}

/* ── pairing proof ──────────────────────────────────────────────────────────── */

const PROOF_AAD = (code: string): string => `pair-confirm:${code}`;
const PROOF_MSG = 'marudesk-pair';

/** The phone seals a fixed token under the derived key — proves it scanned THIS QR. */
export function makePairProof(key: CryptoKey, code: string): Promise<Envelope> {
  return seal(key, PROOF_MSG, PROOF_AAD(code));
}

/** The PC verifies the proof opens to the fixed token under the key it derived. Total. */
export async function verifyPairProof(
  key: CryptoKey,
  code: string,
  proof: Envelope,
): Promise<boolean> {
  try {
    return (await open(key, proof, PROOF_AAD(code))) === PROOF_MSG;
  } catch {
    return false;
  }
}

/* ── AAD builders for the encrypted channel ─────────────────────────────────── */

export const reqAad = (method: string, path: string): string => `req:${method.toUpperCase()} ${path}`;
export const resAad = (path: string): string => `res:${path}`;
/** AAD for every SSE event frame on the encrypted stream. */
export const SSE_AAD = 'sse';

/* ── QR payload codec + defensive decode ───────────────────────────────────── */

export function encodeQrPayload(p: QrPayload): string {
  return bytesToB64url(te.encode(JSON.stringify(p)));
}

/** Parse a scanned QR back into a {@link QrPayload}, or null if it isn't a valid one. */
export function decodeQrPayload(s: string): QrPayload | null {
  try {
    const p = JSON.parse(td.decode(b64urlToBytes(s))) as QrPayload;
    if (p?.v !== E2E_VERSION) return null;
    if (typeof p.code !== 'string' || p.code.length === 0) return null;
    if (typeof p.pcPub !== 'string' || typeof p.name !== 'string') return null;
    if (typeof p.exp !== 'number' || !Array.isArray(p.urls)) return null;
    return p;
  } catch {
    return null;
  }
}
