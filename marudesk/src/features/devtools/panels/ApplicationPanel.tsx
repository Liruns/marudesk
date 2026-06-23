import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import type { TranslationKey } from '../../../i18n/messages';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import { RemoteValue } from '../components/RemoteValue';
import { fmtBytes } from './network-utils';
import type { CacheEntry, CdpCookie, IdbDatabase, IdbEntry, SwVersion } from '../types';

/**
 * Application panel: per-origin storage inspection AND editing over CDP.
 * Local/Session Storage rows are editable (double-click a value to edit, an
 * add-row appends new entries, delete / clear per row) via the DOMStorage
 * domain; cookies support per-cookie delete (Network.deleteCookies, scoped by
 * name+domain+path — cookie writes stay blocked by the relay). "Clear site
 * data" runs the origin-scoped Storage.clearDataForOrigin. IndexedDB and
 * Cache Storage are read-only previews (first page of entries) with the
 * origin-scoped deletes the IndexedDB/CacheStorage domains allow. Every
 * mutation re-reads the origin's storage so tables reflect ground truth.
 */

type Section =
  | 'local'
  | 'session'
  | 'cookies'
  | 'indexeddb'
  | 'cache'
  | 'quota'
  | 'manifest'
  | 'frames'
  | 'sw';
// The original sections carry i18n keys; the newer storage sections (IndexedDB
// / Cache Storage) use registry-style literals, like the Console/Sources copy.
const SECTIONS: { id: Section; labelKey?: TranslationKey; label?: string }[] = [
  { id: 'local', labelKey: 'devtools.application.localStorage' },
  { id: 'session', labelKey: 'devtools.application.sessionStorage' },
  { id: 'indexeddb', labelKey: 'devtools.application.indexeddb' },
  { id: 'cache', labelKey: 'devtools.application.cacheStorage' },
  { id: 'cookies', labelKey: 'devtools.application.cookies' },
  { id: 'quota', labelKey: 'devtools.application.storage' },
  { id: 'manifest', labelKey: 'devtools.application.manifest' },
  { id: 'frames', labelKey: 'devtools.application.frames' },
  { id: 'sw', labelKey: 'devtools.application.serviceWorkers' },
];

/** A storage value cell: double-click to edit in place, Enter/blur commits. */
function EditableValue({
  itemKey,
  value,
  onCommit,
}: {
  itemKey: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <span
        title={t('devtools.dom.doubleClickEdit')}
        onDoubleClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className="cursor-text break-all"
      >
        {value}
      </span>
    );
  }
  const commit = () => {
    setEditing(false);
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
      spellCheck={false}
      autoComplete="off"
      aria-label={`${t('devtools.application.editValueBefore')}${itemKey}`}
      className="w-full bg-surface-page border border-accent rounded-sm px-1 -my-px font-mono text-caption text-fg-primary focus:outline-none"
    />
  );
}

/** The trailing add-row: key + value inputs, committed by Enter or the button. */
function AddRow({ onAdd }: { onAdd: (key: string, value: string) => void }) {
  const { t } = useI18n();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const keyRef = useRef<HTMLInputElement>(null);

  const commit = () => {
    const k = key.trim();
    if (!k) return;
    onAdd(k, value);
    setKey('');
    setValue('');
    keyRef.current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  };
  const inputClass =
    'w-full h-5 rounded-sm bg-surface-2 px-1 font-mono text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-accent/50';
  return (
    <tr className="align-top">
      <td className="px-3 py-1">
        <input
          ref={keyRef}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('devtools.application.newKeyPlaceholder')}
          aria-label={t('devtools.application.newKeyPlaceholder')}
          className={inputClass}
        />
      </td>
      <td className="px-2 py-1">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('devtools.application.newValuePlaceholder')}
          aria-label={t('devtools.application.newValuePlaceholder')}
          className={inputClass}
        />
      </td>
      <td className="px-1 py-1">
        <button
          type="button"
          aria-label={t('devtools.application.addEntry')}
          title={t('devtools.application.addEntry')}
          disabled={!key.trim()}
          onClick={commit}
          className={cn(
            'size-5 rounded flex items-center justify-center',
            key.trim()
              ? 'text-fg-tertiary hover:text-fg-primary hover:bg-surface-2'
              : 'text-fg-disabled cursor-not-allowed',
          )}
        >
          <Plus size={12} />
        </button>
      </td>
    </tr>
  );
}

function StorageTable({
  items,
  onDelete,
  onSet,
}: {
  items: [string, string][];
  onDelete: (key: string) => void;
  onSet: (key: string, value: string) => void;
}) {
  const { t } = useI18n();
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
        {items.length === 0 ? (
          <tr>
            <td colSpan={3} className="text-caption text-fg-tertiary px-3 py-2">
              {t('devtools.application.noEntries')}
            </td>
          </tr>
        ) : (
          items.map(([k, v]) => (
            <tr key={k} className="hover:bg-surface-2 align-top">
              <td className="px-3 py-0.5 font-mono text-fg-primary break-all">{k}</td>
              <td className="px-2 py-0.5 font-mono text-fg-secondary break-all">
                <EditableValue itemKey={k} value={v} onCommit={(value) => onSet(k, value)} />
              </td>
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
          ))
        )}
        <AddRow onAdd={onSet} />
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

function CookieTable({
  cookies,
  onDelete,
}: {
  cookies: CdpCookie[];
  onDelete: (cookie: CdpCookie) => void;
}) {
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
          <th className="px-1 py-1 w-7" />
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
            <td className="px-1 py-0.5">
              <button
                type="button"
                aria-label={`${t('devtools.application.deleteBefore')}${c.name}`}
                title={t('devtools.application.delete')}
                onClick={() => onDelete(c)}
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

/* ── IndexedDB ────────────────────────────────────────────────────────── */

/** One object store's first-page entry preview (read-only). */
function IdbStoreEntries({ database, store }: { database: string; store: string }) {
  const { t } = useI18n();
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
    return <div className="text-caption text-fg-tertiary px-3 py-1">{t('devtools.application.noEntries')}</div>;
  }
  return (
    <table className="w-full text-caption">
      <thead className="text-fg-tertiary">
        <tr className="text-left">
          <th className="font-normal px-3 py-1 w-1/3">{t('devtools.application.colKey')}</th>
          <th className="font-normal px-2 py-1">{t('devtools.application.colValue')}</th>
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
  const { t } = useI18n();
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
          title={t('devtools.application.deleteDatabase')}
          className="h-5 px-1.5 shrink-0 rounded text-caption text-error/80 hover:text-error hover:bg-error/10"
        >
          Delete
        </button>
      </div>
      {open ? (
        <div className="pl-5 pb-1">
          {db.objectStores.length === 0 ? (
            <div className="text-caption text-fg-tertiary px-1.5 py-0.5">{t('devtools.application.noObjectStores')}</div>
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
  const { t } = useI18n();
  const databases = useDevtoolsStore((s) => s.idbDatabases);
  if (databases.length === 0) {
    return <div className="text-caption text-fg-tertiary px-3 py-2">{t('devtools.application.noDatabases')}</div>;
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
  const { t } = useI18n();
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
    return <div className="text-caption text-fg-tertiary px-3 py-1">{t('devtools.application.noEntries')}</div>;
  }
  return (
    <table className="w-full text-caption">
      <thead className="text-fg-tertiary">
        <tr className="text-left">
          <th className="font-normal px-3 py-1">{t('devtools.application.colUrl')}</th>
          <th className="font-normal px-1 py-1 w-14">{t('devtools.application.colMethod')}</th>
          <th className="font-normal px-1 py-1 w-12">{t('devtools.application.colStatus')}</th>
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
                title={t('devtools.application.deleteEntry')}
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
  const { t } = useI18n();
  const caches = useDevtoolsStore((s) => s.cacheNames);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (caches.length === 0) {
    return <div className="text-caption text-fg-tertiary px-3 py-2">{t('devtools.application.noCaches')}</div>;
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
              title={t('devtools.application.deleteCache')}
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

/* ── Storage quota (Storage.getUsageAndQuota) ─────────────────────────── */

function StorageQuotaSection() {
  const { t } = useI18n();
  const usage = useDevtoolsStore((s) => s.storageUsage);
  if (!usage) {
    return (
      <div className="text-caption text-fg-tertiary px-3 py-2">{t('devtools.application.noQuota')}</div>
    );
  }
  const fraction = usage.quota > 0 ? Math.min(1, usage.usage / usage.quota) : 0;
  const maxTypeUsage = Math.max(1, ...usage.breakdown.map((b) => b.usage));
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <div className="text-caption text-fg-secondary tabular-nums">
        {fmtBytes(usage.usage)} used of {fmtBytes(usage.quota)} (
        {(fraction * 100).toFixed(1)}%)
      </div>
      <div className="h-2.5 w-full bg-surface-2 rounded-sm overflow-hidden">
        <div
          className="h-full bg-accent/70 rounded-sm"
          style={{ width: `${usage.usage > 0 ? Math.max(fraction * 100, 0.5) : 0}%` }}
        />
      </div>
      {usage.breakdown.length > 0 ? (
        <div className="flex flex-col gap-1 pt-1">
          {usage.breakdown.map((b) => (
            <div key={b.storageType} className="flex items-center gap-2 text-caption">
              <span className="w-32 shrink-0 text-fg-tertiary truncate">{b.storageType}</span>
              <div className="flex-1 h-2 bg-surface-2 rounded-sm overflow-hidden">
                <div
                  className="h-full bg-accent/50 rounded-sm"
                  style={{ width: `${Math.max((b.usage / maxTypeUsage) * 100, 0.5)}%` }}
                />
              </div>
              <span className="w-20 shrink-0 text-right tabular-nums text-fg-secondary">
                {fmtBytes(b.usage)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ── Manifest (Page.getAppManifest) ───────────────────────────────────── */

/** Manifest text pretty-printed when it parses as JSON (raw otherwise). */
function prettyManifest(data: string): string {
  try {
    return JSON.stringify(JSON.parse(data), null, 2);
  } catch {
    return data;
  }
}

function ManifestSection() {
  const { t } = useI18n();
  const manifest = useDevtoolsStore((s) => s.appManifest);
  const [rawOpen, setRawOpen] = useState(false);
  if (!manifest || !manifest.url) {
    return (
      <div className="text-caption text-fg-tertiary px-3 py-2">{t('devtools.application.noManifest')}</div>
    );
  }
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <div className="font-mono text-caption break-all">
        <span className="text-fg-tertiary">URL: </span>
        <span className="text-fg-secondary">{manifest.url}</span>
      </div>
      {manifest.errors.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {manifest.errors.map((e, i) => (
            <div
              key={i}
              className={cn(
                'font-mono text-caption break-words',
                e.critical ? 'text-error' : 'text-warning',
              )}
            >
              {e.message}{' '}
              <span className="text-fg-tertiary">
                ({e.line}:{e.column})
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {manifest.data ? (
        <div>
          <button
            type="button"
            onClick={() => setRawOpen((o) => !o)}
            className="flex items-center gap-1 text-caption text-fg-secondary hover:text-fg-primary"
          >
            <ChevronRight
              size={12}
              className={cn('text-fg-tertiary transition-transform', rawOpen && 'rotate-90')}
            />
            Raw manifest
          </button>
          {rawOpen ? (
            <pre className="font-mono text-caption text-fg-secondary whitespace-pre-wrap break-words max-h-64 overflow-auto pt-1 pl-4">
              {prettyManifest(manifest.data)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ── Frames (Page.getFrameTree) ───────────────────────────────────────── */

function FramesSection() {
  const { t } = useI18n();
  const frames = useDevtoolsStore((s) => s.frameTree);
  if (!frames || frames.length === 0) {
    return (
      <div className="text-caption text-fg-tertiary px-3 py-2">{t('devtools.application.noFrames')}</div>
    );
  }
  return (
    <div className="flex flex-col py-1">
      {frames.map((f) => (
        <div
          key={f.id}
          className="flex items-baseline gap-2 py-0.5 pr-3 text-caption hover:bg-surface-2"
          style={{ paddingLeft: `${12 + f.depth * 16}px` }}
        >
          <span className="font-mono text-fg-primary break-all">{f.url || '(no url)'}</span>
          {f.name ? <span className="text-fg-tertiary truncate">name: {f.name}</span> : null}
          {f.mimeType ? <span className="text-fg-tertiary shrink-0">{f.mimeType}</span> : null}
        </div>
      ))}
    </div>
  );
}

/* ── Service Workers (ServiceWorker registration/version events) ─────── */

function ServiceWorkersSection() {
  const { t } = useI18n();
  const registrations = useDevtoolsStore((s) => s.swRegistrations);
  const versions = useDevtoolsStore((s) => s.swVersions);
  if (registrations.size === 0) {
    return (
      <div className="text-caption text-fg-tertiary px-3 py-2">
        No service worker registrations
      </div>
    );
  }
  const byRegistration = new Map<string, SwVersion[]>();
  for (const v of versions.values()) {
    const list = byRegistration.get(v.registrationId) ?? [];
    list.push(v);
    byRegistration.set(v.registrationId, list);
  }
  return (
    <div className="flex flex-col">
      {[...registrations.values()].map((r) => {
        const regVersions = byRegistration.get(r.registrationId) ?? [];
        return (
          <div
            key={r.registrationId}
            className="border-b border-subtle/40 px-3 py-1 flex flex-col gap-0.5"
          >
            <div className="font-mono text-caption break-all">
              <span className="text-fg-tertiary">Scope: </span>
              <span className="text-fg-primary">{r.scopeURL}</span>
            </div>
            {regVersions.length === 0 ? (
              <div className="text-caption text-fg-tertiary">{t('devtools.application.noVersions')}</div>
            ) : (
              regVersions.map((v) => (
                <div
                  key={v.versionId}
                  className="font-mono text-caption break-all flex flex-wrap gap-x-2"
                >
                  <span className="text-fg-secondary">{v.scriptURL}</span>
                  <span className="text-fg-tertiary">#{v.versionId}</span>
                  <span
                    className={
                      v.runningStatus === 'running' ? 'text-accent' : 'text-fg-tertiary'
                    }
                  >
                    {v.runningStatus}
                  </span>
                  <span className="text-fg-tertiary">{v.status}</span>
                </div>
              ))
            )}
          </div>
        );
      })}
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
            onSet={(k, v) => void useDevtoolsStore.getState().setStorageItem(true, k, v)}
          />
        ) : section === 'session' ? (
          <StorageTable
            items={session}
            onDelete={(k) => void useDevtoolsStore.getState().removeStorageItem(false, k)}
            onSet={(k, v) => void useDevtoolsStore.getState().setStorageItem(false, k, v)}
          />
        ) : section === 'indexeddb' ? (
          <IndexedDbSection />
        ) : section === 'cache' ? (
          <CacheStorageSection />
        ) : section === 'quota' ? (
          <StorageQuotaSection />
        ) : section === 'manifest' ? (
          <ManifestSection />
        ) : section === 'frames' ? (
          <FramesSection />
        ) : section === 'sw' ? (
          <ServiceWorkersSection />
        ) : (
          <CookieTable
            cookies={cookies}
            onDelete={(c) => void useDevtoolsStore.getState().deleteCookie(c)}
          />
        )}
      </div>
    </div>
  );
}
