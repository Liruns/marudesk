import { create } from 'zustand';
import type { AgentChatState, RelayAccount } from '../types';
import { emptyAgentChatState } from '../types';
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

/** How the phone reaches the agent: the cloud relay (Model B) or a directly-paired PC (T2). */
export type ConnMode = 'relay' | 'direct';

/** Which top-level screen is showing. A tiny hand-rolled router (no deps). */
export type Route = 'connect' | 'login' | 'chat' | 'account';

const DEFAULT_RELAY_URL = 'http://127.0.0.1:8788';

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

  // chat commands (proxied to the active transport)
  sendPrompt: (prompt: string, provider: string, model: string) => Promise<void>;
  abort: () => Promise<void>;
  approve: (approved: boolean) => Promise<void>;
  respond: (answers: Record<string, string>) => Promise<void>;
  resetChat: () => Promise<void>;
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

  async hydrate() {
    const [relayUrl, accessToken, refreshToken, accountRaw, dBase, dDev, dKey] =
      await Promise.all([
        storageGet(StorageKeys.relayUrl),
        storageGet(StorageKeys.accessToken),
        storageGet(StorageKeys.refreshToken),
        storageGet(StorageKeys.account),
        storageGet(StorageKeys.directBaseUrl),
        storageGet(StorageKeys.directDeviceId),
        storageGet(StorageKeys.directKey),
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
    set({ hydrated: true, relayUrl: url, accessToken, refreshToken, account, mode, direct, route });
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
    const { mode, direct, relayUrl, accessToken } = get();
    if (mode === 'direct') {
      if (!direct) {
        set({ route: 'connect' });
        return;
      }
      // Keep the concrete handle for its no-arg connect(), but install it as the
      // active transport so the chat commands route through it.
      const dt = new DirectTransport(direct);
      wire(set, dt);
      try {
        await dt.connect();
      } catch {
        // The transport reports the failure via onStatus; nothing extra to do here.
      }
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
  },

  async reconnect() {
    transport?.disconnect();
    await get().connect();
  },

  clearAuthError() {
    set({ authError: null });
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
    ]);
    set({
      mode: 'relay',
      direct: null,
      chat: emptyAgentChatState(),
      status: { status: 'idle', hostOnline: false },
      route: 'connect',
    });
  },

  async sendPrompt(prompt, provider, model) {
    const t = ensureTransport(set);
    await t.send('send', { provider, model, prompt });
  },

  async abort() {
    const turnId = get().chat.turnId;
    if (!turnId || !transport) return;
    await transport.send('abort', { turnId });
  },

  async approve(approved) {
    const pending = get().chat.pendingApproval;
    if (!pending || !transport) return;
    await transport.send('approve', { turnId: pending.turnId, callId: pending.callId, approved });
  },

  async respond(answers) {
    const pending = get().chat.pendingQuestions;
    if (!pending || !transport) return;
    await transport.send('respond', { turnId: pending.turnId, callId: pending.callId, answers });
  },

  async resetChat() {
    if (!transport) return;
    await transport.send('reset', {});
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
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
