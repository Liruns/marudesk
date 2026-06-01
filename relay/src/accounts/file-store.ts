import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Account, AccountMethod, AccountStore } from './store.ts';

/**
 * Dev-only file-backed {@link AccountStore}. Persists the whole account table as
 * one JSON document at `<dataDir>/accounts.json`. Writes are ATOMIC (write to a
 * temp file in the same dir, then rename over the target) so a crash mid-write
 * can't corrupt the table. All mutations are serialized through an internal
 * promise chain so concurrent requests can't interleave a read-modify-write.
 *
 * NOT for production (no concurrency across processes, whole-file rewrite) — the
 * design (§4) calls for a real DB behind the same interface there.
 */

type Table = { accounts: Account[] };

export class FileAccountStore implements AccountStore {
  private readonly file: string;
  private cache: Table | null = null;
  /** Serializes load/save so reads see a consistent table and writes don't race. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = join(dataDir, 'accounts.json');
  }

  private async load(): Promise<Table> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Table>;
      this.cache = { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = { accounts: [] };
      } else {
        throw err;
      }
    }
    return this.cache;
  }

  private async persist(table: Table): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(table, null, 2), 'utf8');
    await rename(tmp, this.file); // atomic on the same filesystem
    this.cache = table;
  }

  /** Run `fn` exclusively against the loaded table, tail-chained on the queue. */
  private run<T>(fn: (table: Table) => Promise<T> | T): Promise<T> {
    const next = this.queue.then(async () => {
      const table = await this.load();
      return fn(table);
    });
    // Keep the chain alive even if this op rejects, so later ops still run.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  findByEmail(email: string): Promise<Account | null> {
    const key = email.toLowerCase();
    return this.run((t) => t.accounts.find((a) => a.email.toLowerCase() === key) ?? null);
  }

  findById(id: string): Promise<Account | null> {
    return this.run((t) => t.accounts.find((a) => a.id === id) ?? null);
  }

  findByProvider(method: AccountMethod, providerSub: string): Promise<Account | null> {
    return this.run(
      (t) => t.accounts.find((a) => a.method === method && a.providerSub === providerSub) ?? null,
    );
  }

  create(account: Account): Promise<Account> {
    return this.run(async (t) => {
      const key = account.email.toLowerCase();
      if (t.accounts.some((a) => a.email.toLowerCase() === key)) {
        throw new Error('email already registered');
      }
      t.accounts.push(account);
      await this.persist(t);
      return account;
    });
  }

  update(account: Account): Promise<Account> {
    return this.run(async (t) => {
      const idx = t.accounts.findIndex((a) => a.id === account.id);
      if (idx === -1) throw new Error('account not found');
      t.accounts[idx] = account;
      await this.persist(t);
      return account;
    });
  }
}
