import { create } from 'zustand';
import type {
  AgentApprovalMode,
  AgentChatState,
  AgentPlanStepStatus,
  BridgeProviderModels,
  BridgeWorkspaceInfo,
  ReasoningEffort,
  RelayAccount,
  SessionSummary,
} from '../types';
import { emptyAgentChatState, makeAgentSendInput } from '../types';
import { createTransport } from '../transport';
import { DirectTransport } from '../transport/DirectTransport';
import type { DirectCreds, Transport, TransportStatusInfo } from '../transport/types';
import { runPairing } from '../auth/pairing';
import {
  login as apiLogin,
  signup as apiSignup,
  logout as apiLogout,
  normalizeRelayUrl,
} from '../auth/relayClient';
import { StorageKeys, storageGet, storageRemove, storageSet } from '../auth/storage';
import { messageOf } from '../lib/errorMessage';

/** How the phone reaches the agent: the cloud relay (Model B) or a directly-paired PC (T2). */
export type ConnMode = 'relay' | 'direct';

/** Which top-level screen is showing. A tiny hand-rolled router (no deps). */
export type Route = 'connect' | 'login' | 'chat' | 'account';

/** Default relay endpoint shown/used before the user saves one (matches the relay's default port). */
export const DEFAULT_RELAY_URL = 'http://127.0.0.1:8788';

/** The 'no workspace' sentinel persisted when the user explicitly picks global. */
const GLOBAL_WORKSPACE = 'global';

/** Last-resort model pick before the PC catalog has loaded (relay/stub paths). */
const FALLBACK_PROVIDER = 'anthropic';
const FALLBACK_MODEL = 'claude-sonnet-4-6';

type AppState = {
  /** Set once we've read persisted tokens/URL from storage at boot. */
  hydrated: boolean;
  route: Route;

  /** Which connection model is active (relay = Model B; direct = a paired PC, T2). */
  mode: ConnMode;
  /** The paired-PC credentials when `mode === 'direct'`, else null. */
  direct: DirectCreds | null;

  relayUrl: string;
  account: RelayAccount | null;
  accessToken: string | null;
  refreshToken: string | null;

  status: TransportStatusInfo;
  chat: AgentChatState;

  /** Async op flags for the auth/connect forms. */
  busy: boolean;
  authError: string | null;
  /**
   * The last failed chat command's message (e.g. the host refusing a remote
   * self-approval of a gated tool, per the L-1 guard). Transient + dismissable;
   * distinct from `chat.error`, which is PC-owned turn state.
   */
  commandError: string | null;
  /** Local-only debug switch that reveals diagnostics/console UI in Account. */
  developerMode: boolean;

  /* ── PC catalog + chat scope (workspace / sessions / model picks) ────────── */

  /** The PC's open workspaces (from `GET /agent/workspaces`); [] until loaded. */
  workspaces: BridgeWorkspaceInfo[];
  /** The workspace active in the desktop UI right now, or null. */
  pcActiveWorkspaceId: string | null;
  /** The workspace this phone's chat is pinned to (null = the global chat). */
  workspaceId: string | null;
  /** True once the user explicitly picked a workspace (vs. following the PC). */
  workspacePinned: boolean;
  /** The PC's provider/model catalog; [] until loaded. */
  providers: BridgeProviderModels[];
  /** True when the active transport serves the catalog (pickers are usable). */
  catalogReady: boolean;
  /** The provider/model the next send uses (the per-chat model pick). */
  provider: string;
  model: string;
  /** Saved sessions for the current scope; null = not loaded yet. */
  sessions: SessionSummary[] | null;
  sessionsLoading: boolean;

  // actions
  hydrate: () => Promise<void>;
  setRoute: (route: Route) => void;
  setRelayUrl: (url: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<boolean>;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  /** Pair this phone to a PC from a scanned/pasted QR (T2 direct mode). */
  pairWithQr: (qrString: string, deviceName: string) => Promise<boolean>;
  /** Forget the paired PC and return to the connect screen. */
  unpair: () => Promise<void>;
  connect: () => Promise<void>;
  reconnect: () => Promise<void>;
  clearAuthError: () => void;
  clearCommandError: () => void;
  setDeveloperMode: (enabled: boolean) => Promise<void>;

  // chat commands (proxied to the active transport)
  sendPrompt: (prompt: string) => Promise<void>;
  abort: () => Promise<void>;
  approve: (approved: boolean) => Promise<void>;
  respond: (answers: Record<string, string>) => Promise<void>;
  resetChat: () => Promise<void>;
  /** U5: steer the PC-owned plan — cycle a step's status or remove it. */
  editPlanStep: (id: string, op: { status?: AgentPlanStepStatus; remove?: boolean }) => Promise<void>;
  /** U10: flip the PC's approval mode (applies on the next turn). */
  setApprovalMode: (mode: AgentApprovalMode) => Promise<void>;
  /** Flip the PC's reasoning effort (applies on the next turn). */
  setReasoningEffort: (effort: ReasoningEffort) => Promise<void>;

  // PC catalog + chat scope actions
  /** (Re)load the PC's workspaces + provider catalog and reconcile the picks. */
  refreshCatalog: () => Promise<void>;
  /** Pin the chat to a PC workspace (null = the global chat) and re-key the stream. */
  selectWorkspace: (workspaceId: string | null) => Promise<void>;
  /** Load the saved sessions for the current scope (the sessions sheet). */
  loadSessions: () => Promise<void>;
  /** Resume a saved session as the scope's live conversation. */
  resumeSession: (id: string) => Promise<void>;
  /** Pick the provider+model the next send uses (per-chat, persisted). */
  selectModel: (provider: string, model: string) => Promise<void>;
};

/**
 * One transport instance lives for the app's lifetime; the store owns its
 * subscriptions and proxies UI intent to it. Kept outside the store object so it
 * isn't part of React state (it's an imperative handle).
 */
let transport: Transport | null = null;
let unsubState: (() => void) | null = null;
let unsubStatus: (() => void) | null = null;

/** Install `t` as the active transport (disposing any previous one) and wire its streams. */
function wire(set: (partial: Partial<AppState>) => void, t: Transport): Transport {
  unsubState?.();
  unsubStatus?.();
  transport?.disconnect();
  transport = t;
  unsubState = t.onState((chat) => set({ chat }));
  unsubStatus = t.onStatus((status) => set({ status }));
  return t;
}

/** The active transport, creating the default (relay/stub) one on first need. */
function ensureTransport(set: (partial: Partial<AppState>) => void): Transport {
  return transport ?? wire(set, createTransport());
}

export const useAppStore = create<AppState>((set, get) => ({
  hydrated: false,
  route: 'connect',
  mode: 'relay',
  direct: null,
  relayUrl: DEFAULT_RELAY_URL,
  account: null,
  accessToken: null,
  refreshToken: null,
  status: { status: 'idle', hostOnline: false },
  chat: emptyAgentChatState(),
  busy: false,
  authError: null,
  commandError: null,
  developerMode: false,
  workspaces: [],
  pcActiveWorkspaceId: null,
  workspaceId: null,
  workspacePinned: false,
  providers: [],
  catalogReady: false,
  provider: FALLBACK_PROVIDER,
  model: FALLBACK_MODEL,
  sessions: null,
  sessionsLoading: false,

  async hydrate() {
    const [
      relayUrl,
      accessToken,
      refreshToken,
      accountRaw,
      dBase,
      dDev,
      dKey,
      developerModeRaw,
      chatWorkspaceRaw,
      chatProvider,
      chatModel,
    ] = await Promise.all([
      storageGet(StorageKeys.relayUrl),
      storageGet(StorageKeys.accessToken),
      storageGet(StorageKeys.refreshToken),
      storageGet(StorageKeys.account),
      storageGet(StorageKeys.directBaseUrl),
      storageGet(StorageKeys.directDeviceId),
      storageGet(StorageKeys.directKey),
      storageGet(StorageKeys.developerMode),
      storageGet(StorageKeys.chatWorkspace),
      storageGet(StorageKeys.chatProvider),
      storageGet(StorageKeys.chatModel),
    ]);
    let account: RelayAccount | null = null;
    if (accountRaw) {
      try {
        account = JSON.parse(accountRaw) as RelayAccount;
      } catch {
        account = null;
      }
    }
    const url = relayUrl ?? DEFAULT_RELAY_URL;
    const direct: DirectCreds | null =
      dBase && dDev && dKey ? { baseUrl: dBase, deviceId: dDev, keyB64: dKey } : null;
    const mode: ConnMode = direct ? 'direct' : 'relay';
    // A paired PC is the entry; otherwise fall back to the relay sign-in flow.
    const route: Route = direct
      ? 'chat'
      : accessToken && account
        ? 'chat'
        : relayUrl
          ? 'login'
          : 'connect';
    set({
      hydrated: true,
      relayUrl: url,
      accessToken,
      refreshToken,
      account,
      mode,
      direct,
      route,
      developerMode: developerModeRaw === 'true',
      // Restore the chat scope + model picks; an absent workspace key means
      // "follow the PC's active workspace" once the catalog loads.
      workspaceId: chatWorkspaceRaw && chatWorkspaceRaw !== GLOBAL_WORKSPACE ? chatWorkspaceRaw : null,
      workspacePinned: chatWorkspaceRaw !== null,
      ...(chatProvider && chatModel ? { provider: chatProvider, model: chatModel } : {}),
    });
    if (route === 'chat') void get().connect();
  },

  setRoute(route) {
    set({ route, authError: null });
  },

  async setRelayUrl(url) {
    const normalized = normalizeRelayUrl(url) || DEFAULT_RELAY_URL;
    set({ relayUrl: normalized });
    await storageSet(StorageKeys.relayUrl, normalized);
  },

  async signup(email, password) {
    set({ busy: true, authError: null });
    try {
      const res = await apiSignup(get().relayUrl, email, password);
      await persistAuth(res.account, res.accessToken, res.refreshToken);
      set({ account: res.account, accessToken: res.accessToken, refreshToken: res.refreshToken, route: 'chat' });
      void get().connect();
      return true;
    } catch (err) {
      set({ authError: messageOf(err) });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  async login(email, password) {
    set({ busy: true, authError: null });
    try {
      const res = await apiLogin(get().relayUrl, email, password);
      await persistAuth(res.account, res.accessToken, res.refreshToken);
      set({ account: res.account, accessToken: res.accessToken, refreshToken: res.refreshToken, route: 'chat' });
      void get().connect();
      return true;
    } catch (err) {
      set({ authError: messageOf(err) });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  async logout() {
    const { relayUrl, refreshToken, accessToken } = get();
    if (refreshToken) await apiLogout(relayUrl, refreshToken, accessToken ?? undefined);
    transport?.disconnect();
    await Promise.all([
      storageRemove(StorageKeys.accessToken),
      storageRemove(StorageKeys.refreshToken),
      storageRemove(StorageKeys.account),
    ]);
    set({
      account: null,
      accessToken: null,
      refreshToken: null,
      chat: emptyAgentChatState(),
      status: { status: 'idle', hostOnline: false },
      route: 'login',
    });
  },

  async connect() {
    const { mode, direct, relayUrl, accessToken, workspaceId } = get();
    if (mode === 'direct') {
      if (!direct) {
        set({ route: 'connect' });
        return;
      }
      // Keep the concrete handle for its no-arg connect(), but install it as the
      // active transport so the chat commands route through it. Pinned to the
      // restored workspace scope so the first snapshot is the right conversation.
      const dt = new DirectTransport(direct, workspaceId);
      wire(set, dt);
      try {
        await dt.connect();
      } catch {
        // The transport reports the failure via onStatus; nothing extra to do here.
      }
      void get().refreshCatalog();
      return;
    }
    if (!accessToken) {
      set({ route: 'login' });
      return;
    }
    const t = ensureTransport(set);
    try {
      await t.connect(relayUrl, accessToken);
    } catch {
      // The transport reports the failure via onStatus; nothing extra to do here.
    }
    void get().refreshCatalog();
  },

  async reconnect() {
    transport?.disconnect();
    await get().connect();
  },

  clearAuthError() {
    set({ authError: null });
  },

  clearCommandError() {
    set({ commandError: null });
  },

  async setDeveloperMode(enabled: boolean) {
    set({ developerMode: enabled });
    await storageSet(StorageKeys.developerMode, enabled ? 'true' : 'false');
  },

  async pairWithQr(qrString, deviceName) {
    set({ busy: true, authError: null });
    try {
      const creds = await runPairing(qrString, deviceName.trim() || 'My phone');
      await Promise.all([
        storageSet(StorageKeys.directBaseUrl, creds.baseUrl),
        storageSet(StorageKeys.directDeviceId, creds.deviceId),
        storageSet(StorageKeys.directKey, creds.keyB64),
      ]);
      set({ mode: 'direct', direct: creds, route: 'chat' });
      void get().connect();
      return true;
    } catch (err) {
      set({ authError: messageOf(err) });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  async unpair() {
    transport?.disconnect();
    await Promise.all([
      storageRemove(StorageKeys.directBaseUrl),
      storageRemove(StorageKeys.directDeviceId),
      storageRemove(StorageKeys.directKey),
      // Workspace ids are PC-specific — they mean nothing on the next pairing.
      storageRemove(StorageKeys.chatWorkspace),
    ]);
    set({
      mode: 'relay',
      direct: null,
      chat: emptyAgentChatState(),
      status: { status: 'idle', hostOnline: false },
      route: 'connect',
      workspaces: [],
      pcActiveWorkspaceId: null,
      workspaceId: null,
      workspacePinned: false,
      providers: [],
      catalogReady: false,
      sessions: null,
    });
  },

  async sendPrompt(prompt) {
    const { provider, model, workspaceId } = get();
    const t = ensureTransport(set);
    await runCommand(set, () =>
      t.send(
        'send',
        makeAgentSendInput({ provider, model, prompt, workspaceId: workspaceId ?? undefined }),
      ),
    );
  },

  async abort() {
    const turnId = get().chat.turnId;
    if (!turnId || !transport) return;
    await runCommand(set, () => transport!.send('abort', { turnId }));
  },

  async approve(approved) {
    const pending = get().chat.pendingApproval;
    if (!pending || !transport) return;
    // A refused remote approval (L-1: gated tools must be confirmed on the desktop)
    // comes back as an `ok:false` ack; runCommand surfaces it as `commandError`.
    await runCommand(set, () =>
      transport!.send('approve', { turnId: pending.turnId, callId: pending.callId, approved }),
    );
  },

  async respond(answers) {
    const pending = get().chat.pendingQuestions;
    if (!pending || !transport) return;
    await runCommand(set, () =>
      transport!.send('respond', { turnId: pending.turnId, callId: pending.callId, answers }),
    );
  },

  async resetChat() {
    if (!transport) return;
    const { workspaceId } = get();
    // A scoped reset clears the workspace's ACTIVE thread on the PC — the same
    // "New chat" the desktop UI does for it; the next send starts a fresh session.
    await runCommand(set, () => transport!.send('reset', workspaceId ? { workspaceId } : {}));
    // The cleared chat is no longer any saved session; refresh the list lazily.
    set({ sessions: null });
  },

  async editPlanStep(id, op) {
    if (!transport) return;
    // The host echoes the updated plan in the next snapshot; no optimistic patch.
    await runCommand(set, () => transport!.send('edit-plan-step', { id, ...op }));
  },

  async setApprovalMode(mode) {
    const t = ensureTransport(set);
    await runCommand(set, () => t.send('set-approval-mode', { mode }));
  },

  async setReasoningEffort(effort) {
    const t = ensureTransport(set);
    await runCommand(set, () => t.send('set-reasoning-effort', { effort }));
  },

  async refreshCatalog() {
    const t = transport;
    if (!t?.catalog) {
      set({ catalogReady: false });
      return;
    }
    try {
      const [ws, models] = await Promise.all([t.catalog.workspaces(), t.catalog.models()]);
      const state = get();
      // Reconcile the workspace pin: follow the PC's active workspace until the
      // user explicitly picks one; drop a pin whose workspace closed on the PC.
      let workspaceId = state.workspaceId;
      let workspacePinned = state.workspacePinned;
      const stillOpen = workspaceId === null || ws.workspaces.some((w) => w.id === workspaceId);
      if (!workspacePinned) {
        workspaceId = ws.activeWorkspaceId;
      } else if (!stillOpen) {
        workspaceId = ws.activeWorkspaceId;
        workspacePinned = false;
        await storageRemove(StorageKeys.chatWorkspace);
      }
      // Reconcile the model pick: keep a connected pick; otherwise default to the
      // first connected provider's default model (matching the desktop picker).
      let { provider, model } = state;
      const picked = models.providers.find((p) => p.id === provider);
      const pickValid = picked?.connected && (model ? true : false);
      if (!pickValid) {
        const firstConnected = models.providers.find((p) => p.connected && p.models.length > 0);
        if (firstConnected) {
          provider = firstConnected.id;
          model = firstConnected.defaultModelId ?? firstConnected.models[0]!.id;
        }
      }
      set({
        workspaces: ws.workspaces,
        pcActiveWorkspaceId: ws.activeWorkspaceId,
        workspaceId,
        workspacePinned,
        providers: models.providers,
        catalogReady: true,
        provider,
        model,
      });
      // Re-key the stream if reconciliation moved the scope (e.g. first launch
      // adopting the PC's active workspace after connecting globally).
      if (workspaceId !== state.workspaceId) t.setWorkspace?.(workspaceId);
      // Pre-load the scope's sessions so the sheet opens instantly and the
      // active-session highlight is ready; never surface a load error here.
      void get()
        .loadSessions()
        .catch(() => {});
    } catch (err) {
      set({ catalogReady: false, commandError: messageOf(err) });
    }
  },

  async selectWorkspace(workspaceId) {
    const t = transport;
    set({ workspaceId, workspacePinned: true, sessions: null });
    await storageSet(StorageKeys.chatWorkspace, workspaceId ?? GLOBAL_WORKSPACE);
    // Re-key the event stream; its first frame repaints the chat with the
    // workspace's active conversation (what the desktop shows for it).
    t?.setWorkspace?.(workspaceId);
    void get()
      .loadSessions()
      .catch(() => {});
  },

  async loadSessions() {
    const t = transport;
    if (!t?.catalog) return;
    const scope = get().workspaceId;
    set({ sessionsLoading: true });
    try {
      const sessions = await t.catalog.sessions(scope);
      // Drop a stale response if the scope changed while loading.
      if (get().workspaceId === scope) set({ sessions, sessionsLoading: false });
      else set({ sessionsLoading: false });
    } catch (err) {
      set({ sessionsLoading: false, commandError: messageOf(err) });
    }
  },

  async resumeSession(id) {
    const t = transport;
    if (!t?.catalog) return;
    const { workspaceId, sessions } = get();
    await runCommand(set, async () => {
      const ok = await t.catalog!.resumeSession(id, workspaceId);
      if (!ok) {
        throw new Error('Could not resume — finish or stop the running turn on this chat first.');
      }
    });
    // Adopt the resumed conversation's provider/model so the next send continues
    // with the same brain it was using (still changeable from the picker).
    const summary = sessions?.find((s) => s.id === id);
    if (summary && get().commandError === null) {
      await get().selectModel(summary.provider, summary.model);
    }
  },

  async selectModel(provider, model) {
    set({ provider, model });
    await Promise.all([
      storageSet(StorageKeys.chatProvider, provider),
      storageSet(StorageKeys.chatModel, model),
    ]);
  },
}));

/* ── helpers (module-scope; not part of React state) ─────────────────────── */

async function persistAuth(account: RelayAccount, accessToken: string, refreshToken: string): Promise<void> {
  await Promise.all([
    storageSet(StorageKeys.accessToken, accessToken),
    storageSet(StorageKeys.refreshToken, refreshToken),
    storageSet(StorageKeys.account, JSON.stringify(account)),
  ]);
}

/**
 * Run a chat-command send and route any rejection (a lost-ack timeout or an
 * `ok:false` ack — e.g. the host refusing a remote gated-tool approval) into
 * `commandError` so the UI can show it, instead of an unhandled rejection. Clears
 * any prior error on a fresh attempt.
 */
async function runCommand(
  set: (partial: Partial<AppState>) => void,
  run: () => Promise<void>,
): Promise<void> {
  set({ commandError: null });
  try {
    await run();
  } catch (err) {
    set({ commandError: messageOf(err) });
  }
}

/** Test/HMR cleanup hook — drop transport subscriptions. */
export function __disposeTransport(): void {
  unsubState?.();
  unsubStatus?.();
  transport?.disconnect();
  transport = null;
  unsubState = null;
  unsubStatus = null;
}
