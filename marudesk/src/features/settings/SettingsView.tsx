import {
  useCallback,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  Code2,
  Copy,
  Globe,
  Info,
  KeyRound,
  Loader2,
  Palette,
  Plug,
  Plus as PlusIcon,
  QrCode,
  Radio,
  RefreshCw,
  RotateCcw,
  Smartphone,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SERVER_PORT_MAX,
  SERVER_PORT_MIN,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  type AgentApprovalMode,
  type DevtoolsDock,
  type ModelRef,
  type SearchEngine,
  type ThemeMode,
} from '../../../shared/settings';
import {
  MONO_FONT_PRESETS,
  UI_FONT_PRESETS,
  isGenericFamily,
  type FontOption,
} from '../../../shared/fonts';
import type {
  PairedDeviceInfo,
  PairingRequestInfo,
  PairingStartInfo,
  RelayStatus,
  ServerStatus,
} from '../../../shared/remote';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { Button } from '../../components/ui';
import { useSettingsStore, type SettingsCategory } from './store';
import { ProvidersSettings } from './ProvidersSettings';
import { McpServersSettings } from './McpServersSettings';
import { RemoteGuide } from './RemoteGuide';
import { useProvidersStore } from '../providers/store';
import { ProviderGlyph } from '../providers/ProviderGlyph';
import type { ModelEntry, ProviderId } from '../../../shared/providers';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
];

const DOCK_OPTIONS: { value: DevtoolsDock; label: string }[] = [
  { value: 'right', label: 'Right' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'chrome', label: 'Chrome' },
];

const SEARCH_ENGINE_OPTIONS: { value: SearchEngine; label: string }[] = [
  { value: 'google', label: 'Google' },
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'bing', label: 'Bing' },
];

const APPROVAL_MODE_OPTIONS: { value: AgentApprovalMode; label: string }[] = [
  { value: 'read-only', label: 'Read-only' },
  { value: 'ask', label: 'Ask' },
  { value: 'auto', label: 'Auto' },
];

const ON_OFF_OPTIONS: { value: 'on' | 'off'; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
];

const CATEGORIES: {
  id: SettingsCategory;
  label: string;
  icon: ComponentType<{ size?: number }>;
  blurb: string;
}[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette, blurb: 'Theme, interface zoom, and UI font.' },
  { id: 'editor', label: 'Editor', icon: Code2, blurb: 'Code editor font and size.' },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal, blurb: 'Integrated terminal font and shell.' },
  { id: 'browser', label: 'Browser', icon: Globe, blurb: 'Search engine and embedded-browser behavior.' },
  { id: 'providers', label: 'AI Providers', icon: KeyRound, blurb: 'Provider API keys + custom OpenAI-compatible endpoints. Pick the model in the chat.' },
  { id: 'agent', label: 'AI Agent', icon: Bot, blurb: 'How much the agent may do without asking, and paths it must never edit.' },
  { id: 'mcp', label: 'MCP Servers', icon: Plug, blurb: 'Connect external MCP servers (stdio) so the AI Chat can use their tools.' },
  { id: 'devtools', label: 'Browser DevTools', icon: Wrench, blurb: 'How the embedded browser DevTools opens.' },
  { id: 'remote', label: 'Remote access', icon: Radio, blurb: 'A local server so a future companion app can drive the AI Chat.' },
  { id: 'about', label: 'About', icon: Info, blurb: 'Version and runtime details.' },
];

function shellPlaceholder(): string {
  if (typeof navigator === 'undefined') return 'OS default';
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'Default (PowerShell)';
  if (ua.includes('Macintosh')) return 'Default (zsh)';
  return 'Default (bash)';
}

/**
 * The Settings surface, rendered inside a `settings` tab. A VSCode-style left
 * category rail switches the detail panel; every control writes straight
 * through to the persisted store, so there's no save button — changes apply and
 * persist immediately. The AI Providers category (formerly a separate modal) now
 * lives here too, so Settings is the single place for all app configuration.
 */
export function SettingsView() {
  const category = useSettingsStore((s) => s.category);
  const setCategory = useSettingsStore((s) => s.setCategory);
  const active = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0];

  return (
    <div className="flex-1 min-h-0 flex bg-surface-page">
      <aside className="w-52 shrink-0 flex flex-col border-r border-subtle bg-surface-1">
        <header className="h-11 shrink-0 flex items-center px-4 border-b border-subtle">
          <h1 className="text-body font-medium text-fg-primary">Settings</h1>
        </header>
        <nav
          aria-label="Settings categories"
          className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-0.5"
        >
          {CATEGORIES.map((c) => (
            <NavItem
              key={c.id}
              active={c.id === category}
              onClick={() => setCategory(c.id)}
              icon={<c.icon size={15} />}
              label={c.label}
            />
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-2xl px-8 py-8 flex flex-col gap-6">
          <header className="flex flex-col gap-1">
            <h2 className="text-section text-fg-primary">{active.label}</h2>
            <p className="text-body-sm text-fg-tertiary">{active.blurb}</p>
          </header>
          {category === 'appearance' ? <AppearanceCategory /> : null}
          {category === 'editor' ? <EditorCategory /> : null}
          {category === 'terminal' ? <TerminalCategory /> : null}
          {category === 'browser' ? <BrowserCategory /> : null}
          {category === 'providers' ? <ProvidersSettings /> : null}
          {category === 'agent' ? <AgentCategory /> : null}
          {category === 'mcp' ? <McpServersSettings /> : null}
          {category === 'devtools' ? <DevtoolsCategory /> : null}
          {category === 'remote' ? <RemoteCategory /> : null}
          {category === 'about' ? <AboutCategory /> : null}
        </div>
      </div>
    </div>
  );
}

function AppearanceCategory() {
  const a = useSettingsStore((s) => s.settings.appearance);
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field label="Theme" hint="Follow the OS, or force light/dark.">
        <Segmented
          value={a.theme}
          options={THEME_OPTIONS}
          onChange={(theme) => void update({ appearance: { theme } })}
        />
      </Field>
      <Field label="Interface zoom" hint="Scales the whole UI.">
        <Stepper
          value={a.uiZoom}
          min={UI_ZOOM_MIN}
          max={UI_ZOOM_MAX}
          step={10}
          suffix="%"
          name="Interface zoom"
          onChange={(uiZoom) => void update({ appearance: { uiZoom } })}
        />
      </Field>
      <Field
        label="UI font"
        hint="Falls back to the bundled Inter stack when unset or unavailable."
      >
        <FontField
          value={a.uiFontFamily}
          presets={UI_FONT_PRESETS}
          onCommit={(uiFontFamily) => void update({ appearance: { uiFontFamily } })}
        />
      </Field>
    </Section>
  );
}

function EditorCategory() {
  const a = useSettingsStore((s) => s.settings.appearance);
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field label="Font family" hint="Falls back to JetBrains Mono if unavailable.">
        <FontField
          value={a.editorFontFamily}
          presets={MONO_FONT_PRESETS}
          onCommit={(editorFontFamily) =>
            void update({ appearance: { editorFontFamily } })
          }
        />
      </Field>
      <Field label="Font size">
        <Stepper
          value={a.editorFontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          suffix="px"
          name="editor font size"
          onChange={(editorFontSize) =>
            void update({ appearance: { editorFontSize } })
          }
        />
      </Field>
    </Section>
  );
}

function TerminalCategory() {
  const settings = useSettingsStore((s) => s.settings);
  const a = settings.appearance;
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field label="Font family" hint="Falls back to JetBrains Mono if unavailable.">
        <FontField
          value={a.terminalFontFamily}
          presets={MONO_FONT_PRESETS}
          onCommit={(terminalFontFamily) =>
            void update({ appearance: { terminalFontFamily } })
          }
        />
      </Field>
      <Field label="Font size">
        <Stepper
          value={a.terminalFontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          suffix="px"
          name="terminal font size"
          onChange={(terminalFontSize) =>
            void update({ appearance: { terminalFontSize } })
          }
        />
      </Field>
      <Field
        label="Default shell"
        hint="Path or command for the integrated terminal. Leave blank for the OS default; an unknown shell falls back automatically."
      >
        <TextField
          value={settings.terminal.defaultShell}
          placeholder={shellPlaceholder()}
          onCommit={(defaultShell) => void update({ terminal: { defaultShell } })}
        />
      </Field>
    </Section>
  );
}

function BrowserCategory() {
  const browser = useSettingsStore((s) => s.settings.browser);
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field
        label="Search engine"
        hint="Used when the address bar input isn't a URL."
      >
        <Segmented
          value={browser.searchEngine}
          options={SEARCH_ENGINE_OPTIONS}
          onChange={(searchEngine) => void update({ browser: { searchEngine } })}
        />
      </Field>
    </Section>
  );
}

function DevtoolsCategory() {
  const devtools = useSettingsStore((s) => s.settings.devtools);
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field
        label="Open as"
        hint="Right/Bottom dock our own inspector; Chrome opens the built-in DevTools window (for emulation, throttling, and the debugger)."
      >
        <Segmented
          value={devtools.defaultDock}
          options={DOCK_OPTIONS}
          onChange={(defaultDock) => void update({ devtools: { defaultDock } })}
        />
      </Field>
    </Section>
  );
}

function AgentCategory() {
  const agent = useSettingsStore((s) => s.settings.agent);
  const pcControl = useSettingsStore((s) => s.settings.pcControl);
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field
        label="Approval mode"
        hint="Read-only: observe only (no edits / no code). Ask: edits run; sensitive tools (run code, cookies, storage, terminal) ask first. Auto: no prompts."
      >
        <Segmented
          value={agent.approvalMode}
          options={APPROVAL_MODE_OPTIONS}
          onChange={(approvalMode) => void update({ agent: { approvalMode } })}
        />
      </Field>
      <Field
        label="Custom instructions"
        hint="Standing instructions added to every chat — tone, conventions, things to avoid. Added after the base prompt, before any workspace AGENTS/CLAUDE files."
      >
        <InstructionsField
          value={agent.instructions}
          onCommit={(instructions) => void update({ agent: { instructions } })}
        />
      </Field>
      <Field
        label="Never-edit paths"
        hint="Globs the agent may never edit, one per line (* and ** supported)."
      >
        <GlobsField
          value={agent.denyGlobs}
          onCommit={(denyGlobs) => void update({ agent: { denyGlobs } })}
        />
      </Field>
      <Field
        label="Model fallback"
        hint="When your selected model is rate-limited or errors out, retry on the next connected model below instead of failing. Tried top-to-bottom; your selected model is always first."
      >
        <Segmented
          value={agent.fallback.enabled ? 'on' : 'off'}
          options={ON_OFF_OPTIONS}
          onChange={(v) =>
            void update({ agent: { fallback: { ...agent.fallback, enabled: v === 'on' } } })
          }
        />
      </Field>
      {agent.fallback.enabled ? (
        <div className="px-4 py-3">
          <FallbackChain
            order={agent.fallback.order}
            onChange={(order) =>
              void update({ agent: { fallback: { ...agent.fallback, order } } })
            }
          />
        </div>
      ) : null}
      <Field
        label="PC control"
        hint="Let the agent open files, folders, and URLs on this computer and reveal paths in the OS file manager. Acts OUTSIDE your workspace; each action asks for approval unless the mode is Auto. Off by default."
      >
        <Segmented
          value={pcControl.enabled ? 'on' : 'off'}
          options={ON_OFF_OPTIONS}
          onChange={(v) => void update({ pcControl: { enabled: v === 'on' } })}
        />
      </Field>
    </Section>
  );
}

/**
 * The model fail-over chain editor (Settings → Agent). A ranked list of
 * (provider, model) pairs the agent tries in order when the active model is
 * rate-limited / 5xx. Rows reorder with up/down + remove; "Add model" offers
 * every connected, tool-capable model not already in the chain. Refs are stored
 * as provider/model-id (so they survive a catalog refresh); labels + glyphs are
 * resolved live — an unknown/offline ref shows its raw id + a "not connected"
 * tag (the loop skips it at fail-over time).
 */
function FallbackChain({
  order,
  onChange,
}: {
  order: ModelRef[];
  onChange: (order: ModelRef[]) => void;
}) {
  const models = useProvidersStore((s) => s.models);
  const providerStatus = useProvidersStore((s) => s.providerStatus);
  const statusChecked = useProvidersStore((s) => s.statusChecked);
  const refreshProviderStatus = useProvidersStore((s) => s.refreshProviderStatus);
  const [adding, setAdding] = useState(false);

  // Populate connected-provider status (+ each connected provider's model list)
  // if the AI Providers panel hasn't been opened yet this session, so candidates
  // and labels resolve here too.
  useEffect(() => {
    if (!statusChecked) void refreshProviderStatus();
  }, [statusChecked, refreshProviderStatus]);

  const isConnected = (provider: string) => {
    if (provider.startsWith('custom:')) return true;
    const st = providerStatus.find((p) => p.id === provider);
    return !!st?.hasKey || !!st?.oauth;
  };
  const labelFor = (ref: ModelRef) =>
    models.find((m) => m.provider === ref.provider && m.id === ref.model)?.label ?? ref.model;

  const inChain = new Set(order.map((r) => `${r.provider}:${r.model}`));
  const candidates = models.filter(
    (m) => m.tools !== false && isConnected(m.provider) && !inChain.has(`${m.provider}:${m.id}`),
  );

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = order.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const removeAt = (i: number) => onChange(order.filter((_, k) => k !== i));
  const addModel = (m: ModelEntry) => {
    onChange([...order, { provider: m.provider, model: m.id }]);
    setAdding(false);
  };

  return (
    <div className="flex flex-col gap-2">
      {order.length === 0 ? (
        <p className="text-caption text-fg-tertiary">
          No fallback models yet — add one or more below. The agent tries them in
          order when your selected model is rate-limited.
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {order.map((ref, i) => {
            const connected = isConnected(ref.provider);
            return (
              <li
                key={`${ref.provider}:${ref.model}`}
                className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5"
              >
                <span className="w-4 shrink-0 text-center text-caption tabular-nums text-fg-tertiary">
                  {i + 1}
                </span>
                <ProviderGlyph provider={ref.provider as ProviderId} label={labelFor(ref)} size={16} />
                <span className="flex-1 truncate text-body-sm text-fg-secondary">{labelFor(ref)}</span>
                {!connected ? (
                  <span
                    title="This provider isn't connected — it'll be skipped during fallback."
                    className="shrink-0 rounded-pill bg-warning-subtle px-1.5 py-px text-[10px] font-medium text-warning"
                  >
                    not connected
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label="Move up"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  className={STEP_BTN}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  disabled={i === order.length - 1}
                  onClick={() => move(i, 1)}
                  className={STEP_BTN}
                >
                  <ArrowDown size={13} />
                </button>
                <button type="button" aria-label="Remove" onClick={() => removeAt(i)} className={STEP_BTN}>
                  <X size={13} />
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {adding ? (
        <div className="flex max-h-52 flex-col overflow-y-auto rounded-md border border-subtle bg-surface-1">
          {candidates.length === 0 ? (
            <p className="px-3 py-2 text-caption text-fg-tertiary">
              No more connected models to add — connect a provider under Settings → AI Providers.
            </p>
          ) : (
            candidates.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => addModel(m)}
                className="flex items-center gap-2 px-3 py-1.5 text-left text-body-sm text-fg-secondary hover:bg-surface-2 transition-colors duration-fast"
              >
                <ProviderGlyph provider={m.provider} label={m.label} size={16} />
                <span className="flex-1 truncate">{m.label}</span>
              </button>
            ))
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-caption text-accent hover:bg-accent-subtle/40 transition-colors duration-fast"
        >
          <PlusIcon size={13} />
          Add model
        </button>
      )}
    </div>
  );
}

function RemoteCategory() {
  const server = useSettingsStore((s) => s.settings.server);
  const update = useSettingsStore((s) => s.update);
  return (
    <div className="flex flex-col gap-6">
      <Section>
        <Field
          label="Phone access"
          hint="Run a small server on this PC so the marudesk phone app can pair over your Wi-Fi/LAN (or Tailscale) and drive the AI Chat. You just scan a QR to connect — no addresses to type. Off by default."
        >
          <Segmented
            value={server.enabled ? 'on' : 'off'}
            options={ON_OFF_OPTIONS}
            onChange={(v) => void update({ server: { enabled: v === 'on' } })}
          />
        </Field>
      </Section>

      {/* QR pairing is the whole flow: tap "Pair a device", scan, approve. The
          port / network addresses / unattended toggle are power-user details, so
          they live behind Advanced instead of fronting the panel. */}
      {server.enabled ? <DevicePairing /> : null}

      {/* The how-to-pair guide shows whether or not the server is on, so people
          can read the flow before flipping the toggle. When pairing is active the
          QR (in DevicePairing, above) sits right over these steps that explain it. */}
      <RemoteGuide />

      {server.enabled ? <AdvancedRemote /> : null}

      <header className="flex flex-col gap-1">
        <h3 className="text-body font-medium text-fg-primary">Cloud relay</h3>
        <p className="text-caption text-fg-tertiary">
          Log in to a marudesk relay so a phone on the same account can drive this PC&apos;s
          AI Chat from anywhere — both sides connect out to the cloud (no port-forwarding).
          The relay only brokers your account&apos;s messages; your code, credentials, and the
          agent stay on this PC.
        </p>
      </header>
      <CloudRelaySection />
    </div>
  );
}

/**
 * Power-user remote details, tucked behind a disclosure so the default Remote
 * panel is just "toggle on → scan the QR". Holds the listen port, the raw
 * reachable URLs (for Tailscale / manual entry), the unattended toggle, and the
 * network-trust warning — none of which a phone-pairing user needs to see.
 */
function AdvancedRemote() {
  const server = useSettingsStore((s) => s.settings.server);
  const update = useSettingsStore((s) => s.update);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 self-start text-caption uppercase tracking-wider text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
      >
        <ChevronRight size={13} className={cn('transition-transform', open && 'rotate-90')} />
        Advanced — port, network addresses, unattended
      </button>
      {open ? (
        <div className="flex flex-col gap-4">
          <Section>
            <Field label="Port" hint="The TCP port the server listens on (all interfaces).">
              <Stepper
                value={server.port}
                min={SERVER_PORT_MIN}
                max={SERVER_PORT_MAX}
                step={1}
                name="server port"
                onChange={(port) => void update({ server: { port } })}
              />
            </Field>
          </Section>
          <LocalServerReach />
          <UnattendedToggle />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Unattended ("skip approvals") toggle (T2 — docs/t2-secure-pairing-design.md).
 * One switch that drops BOTH human gates so a paired phone can drive the PC
 * hands-free: pairing auto-approves AND gated agent tools run without asking. Off
 * by default; shows a prominent warning while on. A real security trade-off, so
 * it's deliberately verbose.
 */
function UnattendedToggle() {
  const skip = useSettingsStore((s) => s.settings.server.skipApprovals);
  const update = useSettingsStore((s) => s.update);
  return (
    <div className="flex flex-col gap-3">
      <Section>
        <Field
          label="Skip approvals (unattended)"
          hint="Let a paired phone drive this PC hands-free: auto-approve new device pairings AND run sensitive tools (run code, cookies, storage, terminal) without asking. Off by default."
        >
          <Segmented
            value={skip ? 'on' : 'off'}
            options={ON_OFF_OPTIONS}
            onChange={(v) => void update({ server: { skipApprovals: v === 'on' } })}
          />
        </Field>
      </Section>
      {skip ? (
        <div className="flex gap-2.5 rounded-lg bg-warning-subtle px-4 py-3">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
          <p className="text-caption text-fg-secondary leading-relaxed">
            Unattended is on: any device that scans your QR pairs automatically, and the
            agent will run code and other sensitive tools on this PC without asking. Use it
            only on devices and a network you fully trust.{' '}
            <span className="text-fg-primary">Read-only</span> agent mode still blocks edits
            and code regardless.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Live LAN/Tailscale reachability for the local bridge server (T2 — docs/remote-
 * mobile-bridge-design §3). Rendered only while the server is enabled. Surfaces
 * (a) a security warning — the server is reachable by other devices and traffic
 * isn't encrypted yet (end-to-end encryption + device pairing come next) — and
 * (b) every base URL a phone can try, copyable, Tailscale-first. Status is fetched
 * once and kept live via `server:status-changed` (pushed when the server
 * starts/stops). Never sees the bearer token.
 */
function LocalServerReach() {
  const [status, setStatus] = useState<ServerStatus>({
    running: false,
    port: null,
    candidates: [],
  });

  useEffect(() => {
    let alive = true;
    void window.marudesk.invoke('server:status').then((s) => {
      if (alive) setStatus(s);
    });
    const off = window.marudesk.on('server:status-changed', (s) => setStatus(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2.5 rounded-lg bg-warning-subtle px-4 py-3">
        <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
        <p className="text-caption text-fg-secondary leading-relaxed">
          While this is on, any device on your network can reach the bridge and traffic
          isn’t encrypted yet — only turn it on where you trust the network (avoid public
          or coffee-shop Wi-Fi). To reach it across networks, prefer{' '}
          <span className="text-fg-primary">Tailscale</span>, whose tunnel is encrypted.
          End-to-end encryption and device pairing are coming next.
        </p>
      </div>

      <Section>
        <div className="flex flex-col gap-2 px-4 py-3">
          <span className="text-body-sm text-fg-primary">Reachable at</span>
          {status.running && status.candidates.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {status.candidates.map((c) => (
                <li
                  key={c.url}
                  className="flex items-center justify-between gap-3 rounded-md bg-surface-page px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="text-caption text-fg-tertiary">{c.label}</span>
                    <span className="truncate font-mono text-body-sm text-fg-secondary">
                      {c.url}
                    </span>
                  </div>
                  <CopyUrlButton url={c.url} />
                </li>
              ))}
            </ul>
          ) : status.running ? (
            <span className="text-caption text-fg-tertiary">
              No Wi-Fi/LAN or Tailscale address detected yet. Connect to a network (or
              start Tailscale), then reopen Settings.
            </span>
          ) : (
            <span className="text-caption text-fg-tertiary">
              Starting the server… reachable addresses will appear here.
            </span>
          )}
        </div>
      </Section>
    </div>
  );
}

/** Copy one reachable URL to the clipboard, with a brief check-mark confirmation. */
function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await window.marudesk.invoke('clipboard:write-text', url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast({ title: 'Copy failed', description: (err as Error).message, variant: 'error' });
    }
  };
  return (
    <button
      type="button"
      aria-label={`Copy ${url}`}
      onClick={() => void copy()}
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded',
        'text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary',
        'transition-colors duration-fast',
      )}
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
  );
}

/**
 * Device pairing for the direct bridge (T2 ③ — docs/t2-secure-pairing-design.md §4).
 * "Pair a device" mints a QR (the PC public key + reachable URLs + a one-time code)
 * that the phone scans; an approve/reject card appears when a phone completes the
 * handshake; paired phones are listed with a revoke. Pairing exchanges a key, so a
 * paired device's traffic is end-to-end encrypted even over plain Wi-Fi.
 */
function DevicePairing() {
  const [devices, setDevices] = useState<PairedDeviceInfo[]>([]);
  const [pending, setPending] = useState<PairingRequestInfo[]>([]);
  const [start, setStart] = useState<PairingStartInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void window.marudesk
      .invoke('server:list-devices')
      .then(setDevices)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // A phone completed the handshake and awaits approval — show its card.
    return window.marudesk.on('server:pairing-request', (info) =>
      setPending((p) => [...p.filter((x) => x.approvalId !== info.approvalId), info]),
    );
  }, [refresh]);

  const beginPair = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setStart(await window.marudesk.invoke('server:pairing-start'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approvalId: string, approved: boolean): Promise<void> => {
    setPending((p) => p.filter((x) => x.approvalId !== approvalId));
    try {
      await window.marudesk.invoke(
        approved ? 'server:pairing-approve' : 'server:pairing-reject',
        { approvalId },
      );
    } catch {
      // The approval may have already timed out on the host; nothing to recover.
    }
    if (approved) {
      setStart(null); // pairing done — drop the QR
      refresh();
    }
  };

  const revoke = async (device: PairedDeviceInfo): Promise<void> => {
    if (!window.confirm(`Revoke “${device.name}”? It will lose access until paired again.`)) {
      return;
    }
    try {
      setDevices(await window.marudesk.invoke('server:revoke-device', { deviceId: device.deviceId }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-body font-medium text-fg-primary">Pair your phone</h3>
          <p className="text-caption text-fg-tertiary">
            Tap below, scan the QR from the marudesk app, and approve it here. Pairing
            exchanges an encryption key, so traffic stays end-to-end encrypted even over
            plain Wi-Fi.
          </p>
        </div>
        {devices.length > 0 ? (
          <button
            type="button"
            aria-label="Refresh device list"
            onClick={refresh}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary transition-colors duration-fast"
          >
            <RefreshCw size={14} />
          </button>
        ) : null}
      </header>

      {pending.map((req) => (
        <ApprovalCard key={req.approvalId} req={req} onDecide={decide} />
      ))}

      {start ? (
        <QrCard start={start} onClose={() => setStart(null)} />
      ) : (
        <Button
          variant="secondary"
          disabled={busy}
          leadingIcon={<QrCode size={15} />}
          onClick={() => void beginPair()}
        >
          Pair a device
        </Button>
      )}
      {error ? <span className="text-caption text-error">{error}</span> : null}

      {devices.length > 0 ? (
        <Section>
          {devices.map((d) => (
            <DeviceRow key={d.deviceId} device={d} onRevoke={() => void revoke(d)} />
          ))}
        </Section>
      ) : null}
    </div>
  );
}

/** The scannable QR card with the manual-code fallback + an expiry countdown. */
function QrCard({ start, onClose }: { start: PairingStartInfo; onClose: () => void }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const remaining = useCountdown(start.expiresAt);
  const expired = remaining <= 0;

  useEffect(() => {
    let alive = true;
    void QRCode.toDataURL(start.qr, { width: 240, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (alive) setDataUrl(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [start.qr]);

  return (
    <Section>
      <div className="flex flex-col items-center gap-3 px-4 py-5">
        <div className="flex w-full items-center justify-between">
          <span className="text-body-sm text-fg-primary">Scan from your phone</span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex size-7 items-center justify-center rounded text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary transition-colors duration-fast"
          >
            <X size={15} />
          </button>
        </div>
        {expired ? (
          <div className="flex h-[240px] w-[240px] items-center justify-center rounded-lg bg-surface-2 px-6 text-center text-caption text-fg-tertiary">
            Code expired. Close this and tap “Pair a device” again.
          </div>
        ) : dataUrl ? (
          <img
            src={dataUrl}
            width={240}
            height={240}
            alt="Pairing QR code"
            className="rounded-lg bg-white p-2"
          />
        ) : (
          <div className="flex h-[240px] w-[240px] items-center justify-center">
            <Loader2 size={22} className="animate-spin text-fg-tertiary" />
          </div>
        )}
        <div className="flex flex-col items-center gap-1">
          <span className="text-caption text-fg-tertiary">Or enter this code on your phone</span>
          <span className="font-mono text-section tracking-[0.25em] text-fg-primary">
            {start.code}
          </span>
          {!expired ? (
            <span className="text-caption text-fg-tertiary">Expires in {remaining}s</span>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

/** The approve/reject card for an incoming pairing request. */
function ApprovalCard({
  req,
  onDecide,
}: {
  req: PairingRequestInfo;
  onDecide: (approvalId: string, approved: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-subtle bg-accent-subtle px-4 py-3">
      <div className="flex items-center gap-2.5">
        <Smartphone size={18} className="shrink-0 text-accent" aria-hidden />
        <div className="flex min-w-0 flex-col">
          <span className="text-body-sm text-fg-primary">
            Pair “{req.name}”?
          </span>
          <span className="text-caption text-fg-tertiary">
            Fingerprint <span className="font-mono">{req.fingerprint}</span> — approve only if
            it matches your phone.
          </span>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={() => onDecide(req.approvalId, true)}>
          Approve
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onDecide(req.approvalId, false)}>
          Reject
        </Button>
      </div>
    </div>
  );
}

/** One paired-device row: name + fingerprint + last seen, with a revoke. */
function DeviceRow({
  device,
  onRevoke,
}: {
  device: PairedDeviceInfo;
  onRevoke: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Smartphone size={16} className="shrink-0 text-fg-tertiary" aria-hidden />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-body-sm text-fg-primary">{device.name}</span>
          <span className="text-caption text-fg-tertiary">
            <span className="font-mono">{device.fingerprint}</span> ·{' '}
            {device.lastSeenAt ? `last seen ${relativeTime(device.lastSeenAt)}` : 'not connected yet'}
          </span>
        </div>
      </div>
      <button
        type="button"
        aria-label={`Revoke ${device.name}`}
        onClick={onRevoke}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded text-fg-tertiary hover:bg-surface-2 hover:text-error transition-colors duration-fast"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

/** Whole-second countdown to `expiresAt` (epoch ms); 0 once elapsed. */
function useCountdown(expiresAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** Compact relative time ("just now", "5m ago", "3h ago", "2d ago") from an ISO string. */
function relativeTime(iso: string): string {
  const diffMs = Date.now() - Date.parse(iso);
  const min = Math.floor(diffMs / 60_000);
  if (!Number.isFinite(min) || min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Cloud-relay account + connection (Bridge Model B §B2). The relay URL + enable
 * toggle persist in settings; the email/password login goes to main (which stores
 * the tokens encrypted and connects the outbound host) and only a sanitized
 * `{account, connected}` status comes back. The connected-as-host indicator
 * updates live via the `relay:status-changed` event.
 */
function CloudRelaySection() {
  const server = useSettingsStore((s) => s.settings.server);
  const update = useSettingsStore((s) => s.update);

  const [status, setStatus] = useState<RelayStatus>({ account: null, connected: false });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial status + live updates from main (host connect/disconnect, session changes).
  useEffect(() => {
    let alive = true;
    void window.marudesk.invoke('relay:status').then((s) => {
      if (alive) setStatus(s);
    });
    const off = window.marudesk.on('relay:status-changed', (s) => setStatus(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const submit = async (mode: 'login' | 'signup'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.marudesk.invoke('relay:login', {
        relayUrl: server.relayUrl,
        email: email.trim(),
        password,
        mode,
      });
      setStatus(next);
      setPassword('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const logout = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await window.marudesk.invoke('relay:logout'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const account = status.account;

  return (
    <Section>
      <Field
        label="Enable cloud relay"
        hint="When on and logged in, this PC stays connected to the relay as your host. Off by default."
      >
        <Segmented
          value={server.cloudEnabled ? 'on' : 'off'}
          options={ON_OFF_OPTIONS}
          onChange={(v) => void update({ server: { cloudEnabled: v === 'on' } })}
        />
      </Field>
      <Field label="Relay URL" hint="The base URL of your marudesk relay (http or https).">
        <TextField
          value={server.relayUrl}
          placeholder="http://127.0.0.1:8788"
          onCommit={(relayUrl) => void update({ server: { relayUrl } })}
        />
      </Field>

      {account ? (
        <Field
          label="Cloud account"
          hint={
            server.cloudEnabled
              ? status.connected
                ? "Connected to the relay as this account's host."
                : 'Logged in. Connecting to the relay…'
              : 'Logged in. Turn on “Enable cloud relay” to connect as host.'
          }
        >
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-block size-2 rounded-full',
                  status.connected ? 'bg-success' : 'bg-fg-tertiary',
                )}
                aria-hidden
              />
              <span className="text-body-sm text-fg-secondary">{account.email}</span>
            </div>
            <Button variant="secondary" disabled={busy} onClick={() => void logout()}>
              Log out
            </Button>
          </div>
        </Field>
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex flex-col gap-2">
            <input
              type="email"
              value={email}
              placeholder="Email"
              autoComplete="username"
              spellCheck={false}
              onChange={(e) => setEmail(e.target.value)}
              className={cn(
                'h-8 w-full rounded-md bg-surface-page border border-default px-3',
                'text-body-sm text-fg-primary placeholder:text-fg-tertiary',
                'focus:outline-none focus:border-accent transition-colors duration-fast',
              )}
            />
            <input
              type="password"
              value={password}
              placeholder="Password"
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy && email.trim() && password) void submit('login');
              }}
              className={cn(
                'h-8 w-full rounded-md bg-surface-page border border-default px-3',
                'text-body-sm text-fg-primary placeholder:text-fg-tertiary',
                'focus:outline-none focus:border-accent transition-colors duration-fast',
              )}
            />
          </div>
          {error ? <span className="text-caption text-error">{error}</span> : null}
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={busy || !email.trim() || !password}
              onClick={() => void submit('login')}
            >
              Log in
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !email.trim() || !password}
              onClick={() => void submit('signup')}
            >
              Sign up
            </Button>
          </div>
          <p className="text-caption text-fg-tertiary">
            Google and GitHub sign-in arrive once the relay&apos;s OAuth apps are configured.
          </p>
        </div>
      )}
    </Section>
  );
}

function AboutCategory() {
  const reset = useSettingsStore((s) => s.reset);
  return (
    <Section>
      <Field label="Version">
        <span className="text-body-sm font-mono text-fg-secondary">0.1.0 (MVP)</span>
      </Field>
      <Field label="Runtime">
        <span className="text-body-sm font-mono text-fg-secondary">
          Electron · React · TypeScript
        </span>
      </Field>
      <Field label="Security" hint="contextIsolation · sandboxed renderer · safeStorage keys">
        <span className="text-caption text-fg-tertiary">Hardened</span>
      </Field>
      <Field
        label="Reset settings"
        hint="Restore every setting on this screen to its default."
      >
        <button
          type="button"
          onClick={() => {
            if (
              window.confirm('Reset all settings to their defaults?')
            ) {
              void reset();
            }
          }}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-3 rounded-md',
            'text-body-sm text-fg-secondary bg-surface-2',
            'hover:text-fg-primary hover:bg-surface-3 transition-colors duration-fast',
          )}
        >
          <RotateCcw size={14} />
          Reset to defaults
        </button>
      </Field>
    </Section>
  );
}

function NavItem({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'h-8 rounded-md px-2.5 flex items-center gap-2 text-body-sm text-left',
        'transition-colors duration-fast',
        active
          ? 'bg-accent-subtle/40 text-fg-primary'
          : 'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
      )}
    >
      <span className={active ? 'text-accent' : 'text-fg-tertiary'} aria-hidden>
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

function Section({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-lg border border-subtle bg-surface-1 shadow-highlight divide-y divide-subtle">
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-body-sm text-fg-primary">{label}</span>
        {hint ? (
          <span className="text-caption text-fg-tertiary">{hint}</span>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      className="inline-flex rounded-md bg-surface-2 p-0.5 gap-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'px-3 h-7 rounded text-body-sm transition-colors duration-fast',
            value === o.value
              ? 'bg-surface-page text-fg-primary'
              : 'text-fg-tertiary hover:text-fg-secondary',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const STEP_BTN = cn(
  'size-7 rounded flex items-center justify-center shrink-0',
  'text-fg-secondary hover:text-fg-primary hover:bg-surface-2',
  'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
  'transition-colors duration-fast',
);

function Stepper({
  value,
  min,
  max,
  step,
  suffix,
  name,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  /** What this stepper adjusts — used in the +/- button labels (a11y + scoping). */
  name: string;
  onChange: (value: number) => void;
}) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  return (
    <div className="inline-flex items-center gap-1 rounded-md bg-surface-2 p-0.5">
      <button
        type="button"
        aria-label={`Decrease ${name}`}
        disabled={value <= min}
        onClick={() => set(value - step)}
        className={STEP_BTN}
      >
        <Minus />
      </button>
      <span className="min-w-[56px] text-center text-body-sm text-fg-primary tabular-nums">
        {value}
        {suffix}
      </span>
      <button
        type="button"
        aria-label={`Increase ${name}`}
        disabled={value >= max}
        onClick={() => set(value + step)}
        className={STEP_BTN}
      >
        <Plus />
      </button>
    </div>
  );
}

const CUSTOM_FONT = '__custom__';

/** Best-effort "is this font installed?" via FontFaceSet (renderer-only). */
function isFontAvailable(family: string): boolean {
  const f = family.trim();
  if (!f || isGenericFamily(f)) return true;
  try {
    if (!document.fonts?.check) return true;
    return document.fonts.check(`12px '${f.replace(/'/g, '')}'`);
  } catch {
    return true;
  }
}

/**
 * Font picker: a dropdown of curated, cross-platform presets plus a "Custom…"
 * escape hatch that reveals a free-text field. A typed family that isn't
 * detected on this machine shows an inline note — it still works (the fallback
 * stack renders) but the warning sets expectations, covering the "what if the
 * user doesn't have this font installed" case.
 */
function FontField({
  value,
  presets,
  onCommit,
}: {
  value: string;
  presets: readonly FontOption[];
  onCommit: (value: string) => void;
}) {
  const known = presets.some((p) => p.value === value);
  const [customMode, setCustomMode] = useState(!known && value !== '');
  const showCustom = customMode || (!known && value !== '');
  const available = isFontAvailable(value);
  return (
    <div className="flex flex-col items-stretch gap-1.5 w-[240px] max-w-[40vw]">
      <select
        value={showCustom ? CUSTOM_FONT : value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM_FONT) {
            setCustomMode(true);
          } else {
            setCustomMode(false);
            if (v !== value) onCommit(v);
          }
        }}
        className={cn(
          'h-8 w-full rounded-md bg-surface-page border border-default px-2.5',
          'text-body-sm text-fg-primary',
          'focus:outline-none focus:border-accent transition-colors duration-fast',
        )}
      >
        {presets.map((p) => (
          <option key={p.value || 'default'} value={p.value}>
            {p.label}
          </option>
        ))}
        <option value={CUSTOM_FONT}>Custom…</option>
      </select>
      {showCustom ? (
        <TextField value={value} placeholder="Font family name" onCommit={onCommit} />
      ) : null}
      {showCustom && value.trim() && !available ? (
        <span className="text-caption text-warning">
          “{value}” isn’t detected on this system — a fallback font is used.
        </span>
      ) : null}
    </div>
  );
}

function TextField({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [local, setLocal] = useState(value);
  // Reset the draft when the committed value changes upstream, using the
  // store-previous-prop pattern (no effect → no cascading render).
  const [committed, setCommitted] = useState(value);
  if (value !== committed) {
    setCommitted(value);
    setLocal(value);
  }
  const commit = () => {
    if (local !== value) onCommit(local);
  };
  return (
    <input
      type="text"
      value={local}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setLocal(value);
          e.currentTarget.blur();
        }
      }}
      className={cn(
        'h-8 w-[240px] max-w-[40vw] rounded-md bg-surface-page border border-default px-3',
        'text-body-sm text-fg-primary placeholder:text-fg-tertiary',
        'focus:outline-none focus:border-accent transition-colors duration-fast',
      )}
    />
  );
}

/** Multiline editor for a list of path globs (one per line); commits on blur. */
function GlobsField({
  value,
  onCommit,
}: {
  value: string[];
  onCommit: (value: string[]) => void;
}) {
  const text = value.join('\n');
  const [local, setLocal] = useState(text);
  // Reset the draft when the committed list changes upstream (store-previous-prop).
  const [committed, setCommitted] = useState(text);
  if (text !== committed) {
    setCommitted(text);
    setLocal(text);
  }
  const commit = () => {
    const next = local
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (next.join('\n') !== value.join('\n')) onCommit(next);
  };
  return (
    <textarea
      value={local}
      spellCheck={false}
      autoComplete="off"
      rows={5}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      placeholder={'**/.env\n**/secrets/**'}
      className={cn(
        'w-[240px] max-w-[40vw] rounded-md bg-surface-page border border-default px-3 py-2',
        'text-body-sm font-mono text-fg-primary placeholder:text-fg-tertiary resize-y',
        'focus:outline-none focus:border-accent transition-colors duration-fast',
      )}
    />
  );
}

/** Free-text standing instructions for the agent (commit-on-blur, like GlobsField). */
function InstructionsField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [local, setLocal] = useState(value);
  const [committed, setCommitted] = useState(value);
  if (value !== committed) {
    setCommitted(value);
    setLocal(value);
  }
  const commit = () => {
    if (local !== value) onCommit(local);
  };
  return (
    <textarea
      value={local}
      spellCheck={false}
      autoComplete="off"
      rows={5}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      placeholder="e.g. Always reply in Korean. Prefer TypeScript. Keep diffs minimal."
      className={cn(
        'w-[320px] max-w-[40vw] rounded-md bg-surface-page border border-default px-3 py-2',
        'text-body-sm text-fg-primary placeholder:text-fg-tertiary resize-y',
        'focus:outline-none focus:border-accent transition-colors duration-fast',
      )}
    />
  );
}

// Tiny inline glyphs (avoid pulling icon components into a settings-only file).
function Minus() {
  return <span aria-hidden className="block h-px w-2.5 bg-current" />;
}
function Plus() {
  return (
    <span aria-hidden className="relative block size-2.5">
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-current" />
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-current" />
    </span>
  );
}
