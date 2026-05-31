import { useEffect, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
} from 'lucide-react';
import { Badge, Button } from '../../components/ui';
import { cn } from '../../lib/cn';
import { PROVIDERS, getProvider, type ProviderId } from '../../../shared/providers';
import { useProvidersStore } from '../providers/store';

/**
 * AI Providers settings — per-provider API-key management as an accordion of
 * cards. Model *selection* lives in the chat's model-first selector now
 * (docs/agentic-chat-v2-design.md §6.1), so this surface is purely about keys:
 * one card per provider, the active one expands to edit + test its key.
 */
export function ProvidersSettings() {
  const status = useProvidersStore((s) => s.providerStatus);
  const statusChecked = useProvidersStore((s) => s.statusChecked);
  const refreshStatus = useProvidersStore((s) => s.refreshProviderStatus);
  const keyProvider = useProvidersStore((s) => s.keyProvider);
  const selectKeyProvider = useProvidersStore((s) => s.selectKeyProvider);

  // Reflect on-disk key status the first time this opens.
  useEffect(() => {
    if (!statusChecked) void refreshStatus();
  }, [statusChecked, refreshStatus]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-fg-tertiary">
        Keys are stored encrypted via the OS keychain (safeStorage) — never written to
        disk in plaintext. Choose which model to use from the chat's model selector.
      </p>

      <div className="flex flex-col gap-2">
        {PROVIDERS.map((p) => {
          const hasKey = !!status.find((s) => s.id === p.id)?.hasKey;
          return (
            <ProviderCard
              key={p.id}
              providerId={p.id}
              hasKey={hasKey}
              expanded={keyProvider === p.id}
              onSelect={() => selectKeyProvider(p.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function ProviderCard({
  providerId,
  hasKey,
  expanded,
  onSelect,
}: {
  providerId: ProviderId;
  hasKey: boolean;
  expanded: boolean;
  onSelect: () => void;
}) {
  const def = getProvider(providerId);

  return (
    <div className="rounded-lg border border-subtle bg-surface-1 overflow-hidden">
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 h-11 text-left"
      >
        <ChevronRight
          size={14}
          className={cn('text-fg-tertiary shrink-0 transition-transform', expanded && 'rotate-90')}
        />
        <span className="text-body-sm text-fg-primary">{def.label}</span>
        <span className="flex-1" />
        {def.keyless ? (
          <Badge variant="neutral">local</Badge>
        ) : (
          <Badge variant={hasKey ? 'accent' : 'neutral'}>{hasKey ? 'key set' : 'no key'}</Badge>
        )}
      </button>

      {expanded ? (
        <div className="border-t border-subtle px-3 py-3">
          {def.keyless ? (
            <p className="text-caption text-fg-tertiary">{def.apiKeyHint}</p>
          ) : (
            <KeyEditor providerId={providerId} hasKey={hasKey} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function KeyEditor({ providerId, hasKey }: { providerId: ProviderId; hasKey: boolean }) {
  const def = getProvider(providerId);
  const keyInput = useProvidersStore((s) => s.keyInput);
  const busy = useProvidersStore((s) => s.keyBusy);
  const error = useProvidersStore((s) => s.keyError);
  const test = useProvidersStore((s) => s.testByProvider[providerId]);
  const setKey = useProvidersStore((s) => s.setKeyInput);
  const save = useProvidersStore((s) => s.saveProviderKey);
  const clear = useProvidersStore((s) => s.clearProviderKey);
  const testConnection = useProvidersStore((s) => s.testConnection);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [reveal, setReveal] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <span className="text-caption text-fg-tertiary">{def.apiKeyHint}</span>

      <label className="flex flex-col gap-1.5">
        <span className="text-caption uppercase tracking-wider text-fg-tertiary">API key</span>
        <div className="relative">
          <input
            ref={inputRef}
            type={reveal ? 'text' : 'password'}
            value={keyInput}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void save();
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder={def.apiKeyPlaceholder}
            className={cn(
              'h-9 w-full rounded-md bg-surface-page border border-default pl-3 pr-9',
              'font-mono text-body-sm text-fg-primary placeholder:text-fg-tertiary',
              'focus:outline-none focus:border-accent transition-colors duration-fast',
            )}
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? 'Hide key' : 'Reveal key'}
            className="absolute inset-y-0 right-0 w-9 flex items-center justify-center text-fg-tertiary hover:text-fg-primary transition-colors duration-fast"
          >
            {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </label>

      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={busy || keyInput.trim().length === 0}
        >
          {busy ? 'Saving…' : 'Save key'}
        </Button>
        {hasKey ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void testConnection(providerId)}
              disabled={busy || test?.status === 'testing'}
            >
              {test?.status === 'testing' ? 'Testing…' : 'Test connection'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void clear()} disabled={busy}>
              Remove key
            </Button>
          </>
        ) : null}
      </div>

      {test && test.status !== 'idle' && test.status !== 'testing' ? (
        <div
          className={cn(
            'flex items-start gap-2 rounded-md px-3 py-2 text-body-sm break-words',
            test.status === 'ok' ? 'bg-success-subtle/40 text-fg-secondary' : 'bg-error-subtle/40 text-fg-secondary',
          )}
        >
          {test.status === 'ok' ? (
            <CheckCircle2 size={14} className="text-success shrink-0 mt-0.5" />
          ) : (
            <AlertCircle size={14} className="text-error shrink-0 mt-0.5" />
          )}
          <span>{test.message}</span>
        </div>
      ) : null}

      {error ? (
        <div className="text-body-sm text-fg-secondary bg-error-subtle/40 rounded-md px-3 py-2 break-words">
          {error}
        </div>
      ) : null}
    </div>
  );
}
