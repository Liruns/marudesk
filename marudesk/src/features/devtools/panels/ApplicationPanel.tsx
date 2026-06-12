import { useRef, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import type { TranslationKey } from '../../../i18n/messages';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import type { CdpCookie } from '../types';

/**
 * Application panel: per-origin storage inspection AND editing over CDP.
 * Local/Session Storage rows are editable (double-click a value to edit, an
 * add-row appends new entries, delete / clear per row) via the DOMStorage
 * domain; cookies support per-cookie delete (Network.deleteCookies, scoped by
 * name+domain+path — cookie writes stay blocked by the relay). "Clear site
 * data" runs the origin-scoped Storage.clearDataForOrigin. Every mutation
 * re-reads the origin's storage so the table reflects ground truth.
 */

type Section = 'local' | 'session' | 'cookies';
const SECTIONS: { id: Section; labelKey: TranslationKey }[] = [
  { id: 'local', labelKey: 'devtools.application.localStorage' },
  { id: 'session', labelKey: 'devtools.application.sessionStorage' },
  { id: 'cookies', labelKey: 'devtools.application.cookies' },
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
              : 'text-fg-tertiary/40 cursor-not-allowed',
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
            {t(s.labelKey)}
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
        {section !== 'cookies' ? (
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
