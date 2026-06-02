import {
  b64urlToBytes,
  bytesToB64url,
  deriveSharedSecret,
  encodeQrPayload,
  fingerprint,
  generateKeyPair,
  importAesKey,
  resAad,
  seal,
  verifyPairProof,
  type Envelope,
  type PairRequestBody,
  type PairResultBody,
  type QrPayload,
  type UrlCandidate,
} from '../../shared/e2e';
import type { PairingRequestInfo, PairingStartInfo } from '../../shared/remote';
import type { StoredDevice } from '../secrets';

/**
 * Device pairing for the direct LAN/Tailscale bridge (docs/t2-secure-pairing-design
 * §2). A factory (not a module singleton) so it's dependency-injected and the
 * headless harness can drive it with a fake store + auto-approve, no Electron.
 *
 * Flow: `startPairing` mints an ephemeral X25519 keypair + a one-time code and
 * returns the QR payload (the PC's PUBLIC key + the reachable URLs). The phone
 * scans it, derives the same key (ECDH), and POSTs `/pair` with a key-possession
 * proof. `handlePair` verifies the proof, consumes the code, then asks the PC user
 * to APPROVE (showing the device name + fingerprint) before minting + persisting a
 * device and returning its id E2E-sealed under the freshly-derived key.
 */

/** A `/pair` HTTP outcome: a status + a JSON body (an {@link Envelope} on success). */
export type PairOutcome = { status: number; body: unknown };

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

type PairingSession = {
  pcPriv: KeyPair['privateKey'];
  expiresAt: number;
};

type PendingApproval = {
  info: PairingRequestInfo;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type PairingDeps = {
  /** Persist a freshly-paired device (electron/server/devices.ts addDevice). */
  addDevice(rec: StoredDevice): Promise<void>;
  /** Notify the renderer of a pairing request awaiting approve/reject. */
  onPairingRequest(info: PairingRequestInfo): void;
  /**
   * When this returns true, pairing auto-approves (unattended mode — skip the
   * desktop card). Read live each handshake; default behavior (omitted) always asks.
   */
  shouldAutoApprove?: () => boolean;
  /** ms a pairing code/QR stays valid (default 90s). */
  codeTtlMs?: number;
  /** ms to wait for the user's approve/reject before auto-rejecting (default 60s). */
  approvalTimeoutMs?: number;
  /** Clock + id/code generators — injectable for tests. */
  now?: () => number;
  randomId?: () => string;
  genCode?: () => string;
};

export type PairingManager = {
  startPairing(opts: { urls: UrlCandidate[]; pcName: string }): Promise<PairingStartInfo>;
  handlePair(body: unknown): Promise<PairOutcome>;
  approve(approvalId: string): boolean;
  reject(approvalId: string): boolean;
  /** Pending requests (so a late-mounting Settings UI can re-render the cards). */
  listPending(): PairingRequestInfo[];
};

// No-ambiguous-character alphabet for the manual-entry code (no I/L/O/0/1).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function defaultGenCode(len = 8): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** Clamp + strip control chars from the phone-supplied device name (untrusted). */
function sanitizeName(name: string): string {
  const cleaned = name.replace(/\p{Cc}/gu, '').trim().slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'Phone';
}

/** Defensively parse an untrusted `/pair` body into a {@link PairRequestBody}, or null. */
function parsePairRequest(body: unknown): PairRequestBody | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.code !== 'string' || b.code.length === 0) return null;
  if (typeof b.phPub !== 'string' || b.phPub.length === 0) return null;
  if (typeof b.deviceName !== 'string') return null;
  const proof = b.proof as Record<string, unknown> | undefined;
  if (!proof || typeof proof.n !== 'string' || typeof proof.ct !== 'string') return null;
  return {
    code: b.code,
    phPub: b.phPub,
    deviceName: b.deviceName,
    proof: { n: proof.n, ct: proof.ct } satisfies Envelope,
  };
}

export function createPairingManager(deps: PairingDeps): PairingManager {
  const codeTtlMs = deps.codeTtlMs ?? 90_000;
  const approvalTimeoutMs = deps.approvalTimeoutMs ?? 60_000;
  const now = deps.now ?? ((): number => Date.now());
  const randomId = deps.randomId ?? ((): string => globalThis.crypto.randomUUID());
  const genCode = deps.genCode ?? defaultGenCode;

  const sessions = new Map<string, PairingSession>();
  const pending = new Map<string, PendingApproval>();

  function pruneExpired(): void {
    const t = now();
    for (const [code, s] of sessions) if (s.expiresAt < t) sessions.delete(code);
  }

  async function startPairing(opts: {
    urls: UrlCandidate[];
    pcName: string;
  }): Promise<PairingStartInfo> {
    pruneExpired();
    const kp = await generateKeyPair();
    const code = genCode();
    const expiresAt = now() + codeTtlMs;
    sessions.set(code, { pcPriv: kp.privateKey, expiresAt });
    const payload: QrPayload = {
      v: 1,
      code,
      pcPub: bytesToB64url(kp.publicKeyRaw),
      urls: opts.urls,
      name: opts.pcName,
      exp: expiresAt,
    };
    return { qr: encodeQrPayload(payload), code, expiresAt };
  }

  /** Create the pending approval, notify the UI, and resolve when the user decides (or times out). */
  function awaitApproval(info: PairingRequestInfo): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(info.approvalId);
        resolve(false);
      }, approvalTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(info.approvalId, { info, resolve, timer });
      deps.onPairingRequest(info);
    });
  }

  function settle(approvalId: string, approved: boolean): boolean {
    const p = pending.get(approvalId);
    if (!p) return false;
    clearTimeout(p.timer);
    pending.delete(approvalId);
    p.resolve(approved);
    return true;
  }

  async function handlePair(body: unknown): Promise<PairOutcome> {
    const parsed = parsePairRequest(body);
    if (!parsed) return { status: 400, body: { error: 'invalid pair request' } };

    pruneExpired();
    const session = sessions.get(parsed.code);
    if (!session || session.expiresAt < now()) {
      sessions.delete(parsed.code);
      return { status: 403, body: { error: 'pairing code invalid or expired' } };
    }

    let phPubRaw: Uint8Array<ArrayBuffer>;
    try {
      phPubRaw = b64urlToBytes(parsed.phPub);
    } catch {
      return { status: 400, body: { error: 'invalid public key' } };
    }

    // One ECDH: raw bytes (to persist) + the AES key (to verify + seal).
    const keyBytes = await deriveSharedSecret(session.pcPriv, phPubRaw, parsed.code);
    const key = await importAesKey(keyBytes);

    // The proof confirms the phone derived the SAME key from THIS QR (no MITM swap).
    if (!(await verifyPairProof(key, parsed.code, parsed.proof))) {
      return { status: 403, body: { error: 'pairing verification failed' } };
    }

    // Consume the code the moment a valid proof arrives (one device per code, no
    // concurrent approvals for the same code).
    sessions.delete(parsed.code);

    const fp = await fingerprint(phPubRaw);
    const name = sanitizeName(parsed.deviceName);
    // Unattended mode auto-approves (no desktop card); otherwise wait for the user.
    const approved = deps.shouldAutoApprove?.()
      ? true
      : await awaitApproval({ approvalId: randomId(), name, fingerprint: fp });
    if (!approved) return { status: 403, body: { error: 'pairing not approved' } };

    const deviceId = randomId();
    const rec: StoredDevice = {
      deviceId,
      name,
      phPub: parsed.phPub,
      key: bytesToB64url(keyBytes),
      fingerprint: fp,
      createdAt: new Date(now()).toISOString(),
      lastSeenAt: null,
    };
    await deps.addDevice(rec);

    // Return the deviceId already E2E-sealed under the freshly-derived key — the
    // phone opens it and stores { deviceId, key } for the encrypted channel.
    const sealed = await seal(key, { deviceId } satisfies PairResultBody, resAad('/pair'));
    return { status: 200, body: sealed };
  }

  return {
    startPairing,
    handlePair,
    approve: (id) => settle(id, true),
    reject: (id) => settle(id, false),
    listPending: () => [...pending.values()].map((p) => p.info),
  };
}
