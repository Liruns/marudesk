import { useEffect, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  Plus,
  LogIn,
  ExternalLink,
  Loader2,
} from 'lucide-react';
import { Badge, Button } from '../../components/ui';
import { cn } from '../../lib/cn';
import {
  PROVIDERS,
  getProvider,
  type BuiltinProviderId,
  type CustomProviderInfo,
} from '../../../shared/providers';
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
          const ps = status.find((s) => s.id === p.id);
          return (
            <ProviderCard
              key={p.id}
              providerId={p.id}
              hasKey={!!ps?.hasKey}
              oauthConnected={!!ps?.oauth}
              expanded={keyProvider === p.id}
              onSelect={() => selectKeyProvider(p.id)}
            />
          );
        })}
      </div>

      <div className="h-px bg-subtle" />

      <CustomEndpointsSection />
    </div>
  );
}

function ProviderCard({
  providerId,
  hasKey,
  oauthConnected,
  expanded,
  onSelect,
}: {
  providerId: BuiltinProviderId;
  hasKey: boolean;
  oauthConnected: boolean;
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
        {oauthConnected ? (
          <Badge variant="accent">{def.oauthOnly ? 'connected' : 'subscription'}</Badge>
        ) : null}
        {def.keyless ? (
          <Badge variant="neutral">local</Badge>
        ) : def.oauthOnly ? (
          oauthConnected ? null : <Badge variant="neutral">sign in</Badge>
        ) : (
          <Badge variant={hasKey ? 'accent' : 'neutral'}>{hasKey ? 'key set' : 'no key'}</Badge>
        )}
      </button>

      {expanded ? (
        <div className="border-t border-subtle px-3 py-3 flex flex-col gap-3">
          {def.keyless ? (
            <p className="text-caption text-fg-tertiary">{def.apiKeyHint}</p>
          ) : (
            <>
              {def.oauth ? (
                <OAuthConnect providerId={providerId} connected={oauthConnected} />
              ) : null}
              {def.oauthOnly ? null : <KeyEditor providerId={providerId} hasKey={hasKey} />}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * OAuth account/subscription login — docs/oauth-providers-design.md. Generalized
 * over two flows: 'manual-paste' (Anthropic — a hosted callback page shows a
 * `code#state` the user pastes back) and 'loopback' (xAI — a transient local
 * server auto-captures the redirect, so the UI just shows a spinner until the
 * browser callback lands). The agent prefers this connection over any stored API
 * key on the same provider.
 */
function OAuthConnect({
  providerId,
  connected,
}: {
  providerId: BuiltinProviderId;
  connected: boolean;
}) {
  const busy = useProvidersStore((s) => s.oauthBusy);
  const error = useProvidersStore((s) => s.oauthError);
  const startOAuth = useProvidersStore((s) => s.startOAuth);
  const completeOAuth = useProvidersStore((s) => s.completeOAuth);
  const cancelOAuth = useProvidersStore((s) => s.cancelOAuth);
  const disconnectOAuth = useProvidersStore((s) => s.disconnectOAuth);

  const [phase, setPhase] = useState<'idle' | 'manual' | 'waiting'>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');

  const friendly =
    providerId === 'anthropic'
      ? 'Claude'
      : providerId === 'xai'
        ? 'Grok'
        : providerId === 'openai-codex'
          ? 'ChatGPT'
          : providerId === 'google-caa'
            ? 'Google'
            : getProvider(providerId).label;

  const reset = () => {
    setPhase('idle');
    setUrl(null);
    setPasted('');
  };

  const begin = async () => {
    const started = await startOAuth(providerId);
    if (!started) return;
    setUrl(started.url);
    if (started.flow === 'loopback') {
      setPhase('waiting');
      const ok = await completeOAuth(providerId); // blocks until the browser callback
      if (ok) reset();
      else setPhase('idle'); // keep the error visible; allow retry
    } else {
      setPhase('manual');
    }
  };

  const finish = async () => {
    if (pasted.trim().length === 0 || busy) return;
    if (await completeOAuth(providerId, pasted.trim())) reset();
  };

  const cancel = async () => {
    await cancelOAuth(providerId);
    reset();
  };

  const field =
    'h-9 w-full rounded-md bg-surface-page border border-default px-3 font-mono text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-accent transition-colors duration-fast';
  const errorBox = error ? (
    <div className="text-body-sm text-fg-secondary bg-error-subtle/40 rounded-md px-3 py-2 break-words">
      {error}
    </div>
  ) : null;

  if (connected) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-page/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={14} className="text-success shrink-0" />
          <span className="text-body-sm text-fg-primary">Connected — using your {friendly} account</span>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => void disconnectOAuth(providerId)} disabled={busy}>
            Disconnect
          </Button>
        </div>
        <p className="text-caption text-fg-tertiary">
          The agent uses your {friendly} account for this provider (preferred over an API key).
        </p>
        {errorBox}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-page/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-caption uppercase tracking-wider text-fg-tertiary">Sign-in (OAuth)</span>
        <span className="flex-1" />
        {phase === 'waiting' ? (
          <Button variant="ghost" size="sm" onClick={() => void cancel()}>
            Cancel
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => void begin()} disabled={busy}>
            <LogIn size={13} className="mr-1.5" />
            {busy ? 'Opening…' : phase === 'manual' ? 'Reopen sign-in' : `Connect with ${friendly}`}
          </Button>
        )}
      </div>

      {phase === 'waiting' ? (
        <p className="text-caption text-fg-tertiary flex items-center gap-1.5 flex-wrap">
          <Loader2 size={12} className="animate-spin shrink-0" />
          Waiting for you to finish signing in in your browser…
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              reopen <ExternalLink size={11} />
            </a>
          ) : null}
        </p>
      ) : phase === 'manual' && url ? (
        <div className="flex flex-col gap-2">
          <p className="text-caption text-fg-tertiary">
            A browser window opened for you to sign in. After approving, copy the code shown on the
            page and paste it below.{' '}
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              Didn’t open? <ExternalLink size={11} />
            </a>
          </p>
          <input
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void finish();
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder="Paste the code (code#state)"
            className={field}
          />
          <div>
            <Button variant="primary" size="sm" onClick={() => void finish()} disabled={busy || pasted.trim().length === 0}>
              {busy ? 'Connecting…' : 'Finish connecting'}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-caption text-fg-tertiary">
          Sign in with your {friendly} account instead of an API key — no credits needed.
        </p>
      )}

      {errorBox}
    </div>
  );
}

function KeyEditor({ providerId, hasKey }: { providerId: BuiltinProviderId; hasKey: boolean }) {
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

/* ── custom OpenAI-compatible endpoints (OpenRouter / LM Studio / vLLM …) ──── */

function CustomEndpointsSection() {
  const customProviders = useProvidersStore((s) => s.customProviders);
  const loadCustom = useProvidersStore((s) => s.loadCustomProviders);
  const removeCustom = useProvidersStore((s) => s.removeCustomProvider);
  const error = useProvidersStore((s) => s.customError);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void loadCustom();
  }, [loadCustom]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption uppercase tracking-wider text-fg-tertiary">
          Custom endpoints
        </span>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1 text-caption text-fg-tertiary hover:text-accent transition-colors duration-fast"
        >
          <Plus size={12} /> Add endpoint
        </button>
      </div>
      <p className="text-caption text-fg-tertiary">
        Any OpenAI-compatible API — OpenRouter, LM Studio, vLLM, Together, Groq. The
        key is optional; local servers usually need none.
      </p>

      {customProviders.length === 0 && !adding ? (
        <p className="text-caption italic text-fg-tertiary/70">No custom endpoints yet.</p>
      ) : null}

      {customProviders.map((c) => (
        <CustomEndpointCard key={c.id} provider={c} onRemove={() => void removeCustom(c.id)} />
      ))}

      {adding ? <AddEndpointForm onDone={() => setAdding(false)} /> : null}

      {error ? (
        <div className="text-body-sm text-fg-secondary bg-error-subtle/40 rounded-md px-3 py-2 break-words">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function CustomEndpointCard({
  provider,
  onRemove,
}: {
  provider: CustomProviderInfo;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const n = provider.models.length;
  return (
    <div className="rounded-lg border border-subtle bg-surface-1 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 h-11 text-left"
      >
        <ChevronRight
          size={14}
          className={cn('text-fg-tertiary shrink-0 transition-transform', expanded && 'rotate-90')}
        />
        <span className="text-body-sm text-fg-primary shrink-0">{provider.label}</span>
        <span className="text-caption text-fg-tertiary truncate font-mono">{provider.baseUrl}</span>
        <span className="flex-1" />
        <Badge variant="neutral">
          {n} model{n === 1 ? '' : 's'}
        </Badge>
        <Badge variant={provider.hasKey ? 'accent' : 'neutral'}>
          {provider.hasKey ? 'key set' : 'no key'}
        </Badge>
      </button>
      {expanded ? (
        <div className="border-t border-subtle px-3 py-3 flex flex-col gap-3">
          <div className="text-caption text-fg-tertiary">
            Models:{' '}
            <span className="font-mono text-fg-secondary break-all">
              {provider.models.map((m) => m.id).join(', ')}
            </span>
          </div>
          <CustomKeyEditor provider={provider} />
          <div>
            <Button variant="ghost" size="sm" onClick={onRemove}>
              Remove endpoint
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CustomKeyEditor({ provider }: { provider: CustomProviderInfo }) {
  const setCustomKey = useProvidersStore((s) => s.setCustomKey);
  const clearCustomKey = useProvidersStore((s) => s.clearCustomKey);
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (value.trim().length === 0 || busy) return;
    setBusy(true);
    await setCustomKey(provider.id, value.trim());
    setBusy(false);
    setValue('');
  };

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-caption uppercase tracking-wider text-fg-tertiary">
        API key {provider.hasKey ? '(stored)' : '(optional)'}
      </span>
      <div className="relative">
        <input
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder={provider.hasKey ? '•••••••• (replace)' : 'sk-… (leave blank if none)'}
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
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={busy || value.trim().length === 0}
        >
          {busy ? 'Saving…' : 'Save key'}
        </Button>
        {provider.hasKey ? (
          <Button variant="ghost" size="sm" onClick={() => void clearCustomKey(provider.id)} disabled={busy}>
            Remove key
          </Button>
        ) : null}
      </div>
    </label>
  );
}

function AddEndpointForm({ onDone }: { onDone: () => void }) {
  const add = useProvidersStore((s) => s.addCustomProvider);
  const busy = useProvidersStore((s) => s.customBusy);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelsText, setModelsText] = useState('');
  const [apiKey, setApiKey] = useState('');

  const modelIds = modelsText
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const valid =
    label.trim().length > 0 && baseUrl.trim().length > 0 && modelIds.length > 0;

  const submit = async () => {
    if (!valid || busy) return;
    const ok = await add({
      label: label.trim(),
      baseUrl: baseUrl.trim(),
      modelIds,
      apiKey: apiKey.trim() || undefined,
    });
    if (ok) {
      setLabel('');
      setBaseUrl('');
      setModelsText('');
      setApiKey('');
      onDone();
    }
  };

  const field =
    'w-full rounded-md bg-surface-page border border-default px-3 text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-accent transition-colors duration-fast';

  return (
    <div className="rounded-lg border border-subtle bg-surface-1 px-3 py-3 flex flex-col gap-2.5">
      <label className="flex flex-col gap-1">
        <span className="text-caption text-fg-tertiary">Name</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="OpenRouter"
          spellCheck={false}
          className={cn(field, 'h-9')}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-caption text-fg-tertiary">Base URL</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://openrouter.ai/api/v1"
          spellCheck={false}
          autoComplete="off"
          className={cn(field, 'h-9 font-mono')}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-caption text-fg-tertiary">Model ids (comma or newline separated)</span>
        <textarea
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
          rows={2}
          placeholder="anthropic/claude-sonnet-4.6, openai/gpt-5"
          spellCheck={false}
          className={cn(field, 'py-2 font-mono resize-none')}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-caption text-fg-tertiary">API key (optional)</span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-or-… (leave blank for local servers)"
          spellCheck={false}
          autoComplete="off"
          className={cn(field, 'h-9 font-mono')}
        />
      </label>
      <div className="flex items-center gap-2 pt-0.5">
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={!valid || busy}>
          {busy ? 'Adding…' : 'Add endpoint'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
