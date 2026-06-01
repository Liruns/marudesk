/**
 * Account model + storage abstraction. The relay is the auth authority (Bridge
 * Model B §2): accounts live in the cloud. For dev we ship a file-backed JSON
 * impl (./file-store.ts); a real deployment swaps in a DB-backed impl behind the
 * same {@link AccountStore} interface (design §4 prerequisite).
 *
 * Secrets (`passwordHash`/`passwordSalt`) live ONLY in the store and are stripped
 * before an account is ever returned over the wire — see {@link toPublicAccount}.
 */

export type AccountMethod = 'local' | 'google' | 'github';

export type Account = {
  id: string;
  method: AccountMethod;
  email: string;
  displayName?: string;
  /** Present only for `method:'local'`. Never serialized to a client. */
  passwordHash?: string;
  passwordSalt?: string;
  /** Provider subject id, present for `method:'google'|'github'`. */
  providerSub?: string;
  createdAt: string;
};

/** The shape safe to return to a client — no password material. */
export type PublicAccount = {
  id: string;
  method: AccountMethod;
  email: string;
  displayName?: string;
  createdAt: string;
};

export function toPublicAccount(account: Account): PublicAccount {
  const pub: PublicAccount = {
    id: account.id,
    method: account.method,
    email: account.email,
    createdAt: account.createdAt,
  };
  if (account.displayName !== undefined) pub.displayName = account.displayName;
  return pub;
}

/**
 * Persistence interface. Implementations must treat email case-insensitively for
 * lookups (we lowercase on the way in) and persist atomically. All methods async
 * so a DB impl drops in unchanged.
 */
export interface AccountStore {
  /** Lookup by lowercased email, or null. */
  findByEmail(email: string): Promise<Account | null>;
  /** Lookup by id, or null. */
  findById(id: string): Promise<Account | null>;
  /** Lookup by provider + subject id (OAuth identity), or null. */
  findByProvider(method: AccountMethod, providerSub: string): Promise<Account | null>;
  /** Insert a new account (id/createdAt are the caller's responsibility). */
  create(account: Account): Promise<Account>;
  /** Persist mutations to an existing account (matched by id). */
  update(account: Account): Promise<Account>;
}
