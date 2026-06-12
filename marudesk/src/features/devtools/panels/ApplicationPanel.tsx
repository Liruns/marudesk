import { useEffect, useState } from 'react';
import { ChevronRight, RefreshCw, Trash2 } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import type { TranslationKey } from '../../../i18n/messages';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import { RemoteValue } from '../components/RemoteValue';
import type { CacheEntry, CdpCookie, IdbDatabase, IdbEntry } from '../types';

/**
 * Application panel: per-origin storage inspection over CDP. Local/Session
 * Storage are editable (delete row / clear) via the DOMStorage domain; cookies
 * are READ-ONLY (the set/delete CDP methods are blocked by the relay). "Clear
 * site data" runs the origin-scoped Storage.clearDataForOrigin. IndexedDB and
 * Cache Storage are read-only previews (first page of entries) with the
 * origin-scoped deletes the IndexedDB/CacheStorage domains allow.
 */

type Section = 'local' | 'session' | 'cookies' | 'indexeddb' | 'cache';
// The original sections carry i18n keys; the newer storage sections (IndexedDB
// / Cache Storage) use registry-style literals, like the Console/Sources copy.
const SECTIONS: { id: Section; labelKey?: TranslationKey; label?: string }[] = [
  { id: 'local', labelKey: 'devtools.application.localStorage' },
  { id: 'session', labelKey: 'devtools.application.sessionStorage' },
  { id: 'indexeddb', label: 'IndexedDB' },
  { id: 'cache', label: 'Cache Storage' },
  { id: 'cookies', labelKey: 'devtools.application.cookies' },
];

function StorageTable({
  items,
  onDelete,
}: {
  items: [string, string][];
  onDelete: (key: string) => void;
}) {
  const { t } = useI18n();
  if (items.length === 0) {
    return <div className="text-caption text-fg-tertiary px-3 py-2">{t('devtools.application.noEntries')}</div>;
  }
  return (
    <table className="w-full text-caption">
      <thead className="sticky top-0 bg-surface-1 text-fg-tertiary">
        <tr className="text-left">
          <th className="font-normal px-3 py-1 w-1/3">{t('devtools.application.key')}</th>
          <th className="font-normal px-2 py-1">{t('devtools.application.value')}</th>
          <th className="px-1 py-1 w-7" />
        </tr>
      </thead>
      <tbody>
        {items.map(([k, v]) => (
          <tr key={k} className="hover:bg-surface-2 align-top">
            <td className="px-3 py-0.5 font-mono text-fg-primary break-all">{k}</td>
            <td className="px-2 py-0.5 font-mono text-fg-secondary break-all">{v}</td>
            <td className="px-1 py-0.5">
              <button
                type="button"
                aria-label={`${t('devtools.application.deleteBefore')}${k}`}
                title={t('devtools.application.delete')}
                onClick={() => onDelete(k)}
                className="size-5 rounded flex items-center justify-center text-fg-tertiary hover:text-error hover:bg-surface-2"
              >
                <Trash2 size={12} />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function cookieExpiry(c: CdpCookie, sessionLabel: string): string {
  if (c.session || !c.expires || c.expires < 0) return sessionLabel;
  try {
    return new Date(c.expires * 1000).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return '—';
  }
}

function CookieTable({ cookies }: { cookies: CdpCookie[] }) {
  const { t } = useI18n();
  if (cookies.length === 0) {
    return <div className="text-caption text-fg-tertiary px-3 py-2">{t('devtools.application.noCookies')}</div>;
  }
  return (
    <table className="w-full text-caption">
      <thead className="sticky top-0 bg-surface-1 text-fg-tertiary">
        <tr className="text-left">
          <th className="font-normal px-3 py-1">{t('devtools.application.name')}</th>
          <th className="font-normal px-2 py-1">{t('devtools.application.value')}</th>
          <th className="font-normal px-2 py-1">{t('devtools.application.domain')}</th>
          <th className="font-normal px-2 py-1">{t('devtools.application.path')}</th>
          <th className="font-normal px-2 py-1">{t('devtools.application.expires')}</th>
          <th className="font-normal px-2 py-1">{t('devtools.application.flags')}</th>
        </tr>
      </thead>
      <tbody>
        {cookies.map((c, i) => (
          <tr key={`${c.name}-${c.domain}-${i}`} className="hover:bg-surface-2 align-top">
            <td className="px-3 py-0.5 font-mono text-fg-primary break-all">{c.name}</td>
            <td className="px-2 py-0.5 font-mono text-fg-secondary break-all max-w-0 truncate">
              {c.value}
            </td>
            <td className="px-2 py-0.5 text-fg-tertiary break-all">{c.domain}</td>
            <td className="px-2 py-0.5 text-fg-tertiary break-all">{c.path}</td>
            <td className="px-2 py-0.5 text-fg-tertiary tabular-nums whitespace-nowrap">
              {cookieExpiry(c, t('devtools.application.session'))}
            </td>
            <td className="px-2 py-0.5 text-fg-tertiary whitespace-nowrap">
              {[c.httpOnly ? 'HttpOnly' : '', c.secure ? 'Secure' : '', c.sameSite ?? '']
                .filter(Boolean)
                .join(' ')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── IndexedDB ────────────────────────────────────────────────────────── */

/** One object store's first-page entry preview (read-only). */
function IdbStoreEntries({ database, store }: { database: string; store: string }) {
  // Mounted per selected store (the parent keys the conditional render), so
  // `database`/`store` are stable for this component's lifetime — no reset.
  const [entries, setEntries] = useState<IdbEntry[] | null>(null);
  useEffect(() => {
    let stale = false;
    void useDevtoolsStore
      .getState()
      .loadIdbEntries(database, store)
      .then((rows) => {
        if (!stale) setEntries(rows);
      });
    return () => {
      stale = true;
    };
  }, [database, store]);

  if (entries === null) {
    return <div className="text-caption text-fg-tertiary px-3 py-1">Loading entries…</div>;
  }
  if (entries.length === 0) {
    return <div className="text-caption text-fg-tertiary px-3 py-1">No entries</div>;
  }
  return (
    <table className="w-full text-caption">
      <thead className="text-fg-tertiary">
        <tr className="text-left">
          <th className="font-normal px-3 py-1 w-1/3">Key</th>
          <th className="font-normal px-2 py-1">Value</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e, i) => (
          <tr key={i} className="hover:bg-surface-2 align-top">
            <td className="px-3 py-0.5 font-mono break-all">
              <RemoteValue obj={e.key} />
            </td>
            <td className="px-2 py-0.5 font-mono break-all">
              <RemoteValue obj={e.value} expandable />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IdbDatabaseSection({ db }: { db: IdbDatabase }) {
  const [open, setOpen] = useState(false);
  const [selectedStore, setSelectedStore] = useState<string | null>(null);
  return (
    <div className="border-b border-subtle/40">
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex-1 min-w-0 flex items-center gap-1 text-left text-caption text-fg-primary hover:text-fg-primary"
        >
          <ChevronRight
            size={12}
            className={cn('shrink-0 text-fg-tertiary transition-transform', open && 'rotate-90')}
          />
          <span className="font-mono truncate">{db.name}</span>
          <span className="text-fg-tertiary tabular-nums shrink-0">
            v{db.version} · {db.objectStores.length} store
            {db.objectStores.length === 1 ? '' : 's'}
          </span>
        </button>
        <button
          type="button"
          onClick={() => void useDevtoolsStore.getState().deleteIdbDatabase(db.name)}
          title="Delete database"
          className="h-5 px-1.5 shrink-0 rounded text-caption text-error/80 hover:text-error hover:bg-error/10"
        >
          Delete
        </button>
      </div>
      {open ? (
        <div className="pl-5 pb-1">
          {db.objectStores.length === 0 ? (
            <div className="text-caption text-fg-tertiary px-1.5 py-0.5">No object stores</div>
          ) : (
            db.objectStores.map((os) => (
              <div key={os.name}>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedStore((cur) => (cur === os.name ? null : os.name))
                  }
                  className={cn(
                    'w-full text-left px-1.5 py-0.5 flex items-baseline gap-2 text-caption',
                    selectedStore === os.name
                      ? 'bg-accent-subtle/50 text-fg-primary'
                      : 'text-fg-secondary hover:bg-surface-2',
                  )}
                >
                  <span className="font-mono truncate">{os.name}</span>
                  <span className="text-fg-tertiary truncate">
                    {os.keyPath ? `keyPath: ${os.keyPath}` : 'out-of-line keys'}
                    {os.autoIncrement ? ' · autoIncrement' : ''}
                  </span>
                </button>
                {selectedStore === os.name ? (
                  <IdbStoreEntries database={db.name} store={os.name} />
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function IndexedDbSection() {
  const databases = useDevtoolsStore((s) => s.idbDatabases);
  if (databases.length === 0) {
    return <div className="text-caption text-fg-tertiary px-3 py-2">No IndexedDB databases</div>;
  }
  return (
    <div>
      {databases.map((db) => (
        <IdbDatabaseSection key={db.name} db={db} />
      ))}
    </div>
  );
}

/* ── Cache Storage ────────────────────────────────────────────────────── */

function CacheEntriesTable({ cacheId }: { cacheId: string }) {
  // Mounted per selected cache; on a per-entry delete `reloadSeq` re-reads and
  // the previous rows stay visible until the fresh page lands (quieter UX).
  const [entries, setEntries] = useState<CacheEntry[] | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  useEffect(() => {
    let stale = false;
    void useDevtoolsStore
      .getState()
      .loadCacheEntries(cacheId)
      .then((rows) => {
        if (!stale) setEntries(rows);
      });
    return () => {
      stale = true;
    };
  }, [cacheId, reloadSeq]);

  if (entries === null) {
    return <div className="text-caption text-fg-tertiary px-3 py-1">Loading entries…</div>;
  }
  if (entries.length === 0) {
    return <div className="text-caption text-fg-tertiary px-3 py-1">No entries</div>;
  }
  return (
    <table className="w-full text-caption">
      <thead className="text-fg-tertiary">
        <tr className="text-left">
          <th className="font-normal px-3 py-1">URL</th>
          <th className="font-normal px-1 py-1 w-14">Method</th>
          <th className="font-normal px-1 py-1 w-12">Status</th>
          <th className="px-1 py-1 w-7" />
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.requestURL} className="hover:bg-surface-2 align-top">
            <td className="px-3 py-0.5 font-mono text-fg-primary break-all">{e.requestURL}</td>
            <td className="px-1 py-0.5 text-fg-tertiary tabular-nums">{e.requestMethod}</td>
            <td className="px-1 py-0.5 text-fg-tertiary tabular-nums">{e.responseStatus}</td>
            <td className="px-1 py-0.5">
              <button
                type="button"
                aria-label={`Delete cache entry ${e.requestURL}`}
                title="Delete entry"
                onClick={() => {
                  void useDevtoolsStore
                    .getState()
                    .deleteCacheEntry(cacheId, e.requestURL)
                    .then(() => setReloadSeq((n) => n + 1));
                }}
                className="size-5 rounded flex items-center justify-center text-fg-tertiary hover:text-error hover:bg-surface-2"
              >
                <Trash2 size={12} />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CacheStorageSection() {
  const caches = useDevtoolsStore((s) => s.cacheNames);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (caches.length === 0) {
    return <div className="text-caption text-fg-tertiary px-3 py-2">No caches</div>;
  }
  return (
    <div>
      {caches.map((c) => (
        <div key={c.cacheId} className="border-b border-subtle/40">
          <div className="flex items-center gap-1 px-1.5 py-1">
            <button
              type="button"
              onClick={() =>
                setSelectedId((cur) => (cur === c.cacheId ? null : c.cacheId))
              }
              className="flex-1 min-w-0 flex items-center gap-1 text-left text-caption hover:text-fg-primary"
            >
              <ChevronRight
                size={12}
                className={cn(
                  'shrink-0 text-fg-tertiary transition-transform',
                  selectedId === c.cacheId && 'rotate-90',
                )}
              />
              <span className="font-mono text-fg-primary truncate">{c.cacheName}</span>
            </button>
            <button
              type="button"
              onClick={() => void useDevtoolsStore.getState().deleteCache(c.cacheId)}
              title="Delete cache"
              className="h-5 px-1.5 shrink-0 rounded text-caption text-error/80 hover:text-error hover:bg-error/10"
            >
              Delete
            </button>
          </div>
          {selectedId === c.cacheId ? <CacheEntriesTable cacheId={c.cacheId} /> : null}
        </div>
      ))}
    </div>
  );
}

export function ApplicationPanel() {
  const { t } = useI18n();
  const origin = useDevtoolsStore((s) => s.appOrigin);
  const local = useDevtoolsStore((s) => s.localStorageItems);
  const session = useDevtoolsStore((s) => s.sessionStorageItems);
  const cookies = useDevtoolsStore((s) => s.cookies);
  const loading = useDevtoolsStore((s) => s.appLoading);
  const [section, setSection] = useState<Section>('local');

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-1 px-1.5 py-1 border-b border-subtle flex-wrap">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={section === s.id}
            onClick={() => setSection(s.id)}
            className={cn(
              'h-6 px-2 rounded text-caption transition-colors duration-fast',
              section === s.id
                ? 'bg-surface-page text-fg-primary'
                : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
            )}
          >
            {s.labelKey ? t(s.labelKey) : (s.label ?? s.id)}
          </button>
        ))}
        <div className="flex-1" />
        <button
          type="button"
          aria-label={t('git.action.refresh')}
          title={t('git.action.refresh')}
          onClick={() => void useDevtoolsStore.getState().refreshApplication()}
          className="size-6 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
        >
          <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
        </button>
        {section === 'local' || section === 'session' ? (
          <button
            type="button"
            onClick={() =>
              void useDevtoolsStore.getState().clearStorage(section === 'local')
            }
            className="h-6 px-2 rounded text-caption text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
          >
            {t('devtools.application.clear')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void useDevtoolsStore.getState().clearSiteData()}
          title={t('devtools.application.clearSiteDataTitle')}
          className="h-6 px-2 rounded text-caption text-error/80 hover:text-error hover:bg-error/10"
        >
          {t('devtools.application.clearSiteData')}
        </button>
      </div>

      <div className="shrink-0 px-3 py-0.5 text-caption text-fg-tertiary font-mono truncate border-b border-subtle/40">
        {origin ?? t('devtools.application.noOrigin')}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {section === 'local' ? (
          <StorageTable
            items={local}
            onDelete={(k) => void useDevtoolsStore.getState().removeStorageItem(true, k)}
          />
        ) : section === 'session' ? (
          <StorageTable
            items={session}
            onDelete={(k) => void useDevtoolsStore.getState().removeStorageItem(false, k)}
          />
        ) : section === 'indexeddb' ? (
          <IndexedDbSection />
        ) : section === 'cache' ? (
          <CacheStorageSection />
        ) : (
          <CookieTable cookies={cookies} />
        )}
      </div>
    </div>
  );
}
