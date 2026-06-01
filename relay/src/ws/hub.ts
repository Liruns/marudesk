/**
 * The relay broker — a payload-AGNOSTIC dumb pipe (Bridge Model B §1, §6).
 *
 * Every authenticated socket is bound to `{ accountId, role }`. Per account we
 * keep two sets: `hosts` (the PC) and `clients` (phones/web). The ONLY routing
 * rule, enforced here and nowhere else:
 *   - a CLIENT's message is forwarded to that same account's HOST(s);
 *   - a HOST's message is forwarded to that same account's CLIENT(s).
 * Never across accounts. We forward an opaque `{ payload: unknown }` envelope and
 * never parse agent semantics — keeping the relay a dumb pipe and leaving room
 * for future end-to-end encryption.
 *
 * Transport-agnostic: the hub talks to a minimal {@link HubSocket}, so it's
 * unit-testable with fakes; the server adapts `ws` sockets to it.
 */

export type Role = 'host' | 'client';

/** Minimal socket surface the hub needs — satisfied by a `ws` WebSocket adapter. */
export interface HubSocket {
  /** Send a UTF-8 text frame. */
  sendText(data: string): void;
  /** Close the socket with an optional code/reason. */
  close(code?: number, reason?: string): void;
}

/** The opaque envelope the relay forwards. `payload` is never inspected. */
export type RelayFrame = { type: 'relay'; from: Role; payload: unknown };

type AccountBucket = { hosts: Set<HubSocket>; clients: Set<HubSocket> };

export type HubLimits = {
  /** Max forwarded message size in bytes; larger frames are dropped + socket closed. */
  maxMessageBytes: number;
};

export class RelayHub {
  private readonly accounts = new Map<string, AccountBucket>();
  private readonly limits: HubLimits;

  constructor(limits: HubLimits = { maxMessageBytes: 1024 * 1024 }) {
    this.limits = limits;
  }

  private bucket(accountId: string): AccountBucket {
    let b = this.accounts.get(accountId);
    if (!b) {
      b = { hosts: new Set(), clients: new Set() };
      this.accounts.set(accountId, b);
    }
    return b;
  }

  /** Register a freshly-authenticated socket under its account + role. */
  register(accountId: string, role: Role, socket: HubSocket): void {
    const b = this.bucket(accountId);
    (role === 'host' ? b.hosts : b.clients).add(socket);
  }

  /** Remove a socket on close; prune the account bucket when empty. */
  unregister(accountId: string, role: Role, socket: HubSocket): void {
    const b = this.accounts.get(accountId);
    if (!b) return;
    (role === 'host' ? b.hosts : b.clients).delete(socket);
    if (b.hosts.size === 0 && b.clients.size === 0) this.accounts.delete(accountId);
  }

  /** Current peer counts for an account (used by status frames / tests). */
  counts(accountId: string): { hosts: number; clients: number } {
    const b = this.accounts.get(accountId);
    return { hosts: b ? b.hosts.size : 0, clients: b ? b.clients.size : 0 };
  }

  /**
   * Route one inbound raw message from `sender`. Returns the number of peers it
   * was forwarded to. Enforces the size cap (oversize → close sender, forward to
   * none) and the same-account host<->client rule. `raw` is treated as opaque.
   */
  route(accountId: string, role: Role, sender: HubSocket, raw: string): number {
    if (Buffer.byteLength(raw, 'utf8') > this.limits.maxMessageBytes) {
      sender.close(1009, 'message too large');
      return 0;
    }
    const b = this.accounts.get(accountId);
    if (!b) return 0;
    const targets = role === 'client' ? b.hosts : b.clients;
    const frame: RelayFrame = { type: 'relay', from: role, payload: this.unwrap(raw) };
    const text = JSON.stringify(frame);
    let delivered = 0;
    for (const target of targets) {
      if (target === sender) continue; // never echo to self
      target.sendText(text);
      delivered += 1;
    }
    return delivered;
  }

  /**
   * Pull `.payload` out of a client envelope if present, else forward the raw
   * text as the payload. The relay does NOT validate payload shape — it only
   * peels one `{payload}` layer so peers exchange `{type:'relay',from,payload}`.
   */
  private unwrap(raw: string): unknown {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && 'payload' in parsed) {
        return (parsed as { payload: unknown }).payload;
      }
      return parsed;
    } catch {
      return raw; // non-JSON: forward the literal text as the payload
    }
  }
}
