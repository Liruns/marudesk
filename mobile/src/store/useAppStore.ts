import { create } from 'zustand';
import type { AgentChatState, RelayAccount } from '../types';
import { emptyAgentChatState } from '../types';
import { createTransport } from '../transport';
import type { Transport, TransportStatusInfo } from '../transport';
import {
  login as apiLogin,
  signup as apiSignup,
  logout as apiLogout,
  normalizeRelayUrl,
} from '../auth/relayClient';
import { StorageKeys, storageGet, storageRemove, storageSet } from '../auth/storage';

/** Which top-level screen is showing. A tiny hand-rolled router (no deps). */
export type Route = 'connect' | 'login' | 'chat' | 'account';

const DEFAULT_RELAY_URL = 'http://127.0.0.1:8788';

type AppState = {
  /** Set once we've read persisted tokens/URL from storage at boot. */
  hydrated: boolean;
  route: Route;

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

function ensureTransport(set: (partial: Partial<AppState>) => void): Transport {
  if (transport) return transport;
  transport = createTransport();
  unsubState = transport.onState((chat) => set({ chat }));
  unsubStatus = transport.onStatus((status) => set({ status }));
  return transport;
}

export const useAppStore = create<AppState>((set, get) => ({
  hydrated: false,
  route: 'connect',
  relayUrl: DEFAULT_RELAY_URL,
  account: null,
  accessToken: null,
  refreshToken: null,
  status: { status: 'idle', hostOnline: false },
  chat: emptyAgentChatState(),
  busy: false,
  authError: null,

  async hydrate() {
    const [relayUrl, accessToken, refreshToken, accountRaw] = await Promise.all([
      storageGet(StorageKeys.relayUrl),
      storageGet(StorageKeys.accessToken),
      storageGet(StorageKeys.refreshToken),
      storageGet(StorageKeys.account),
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
    // Decide the entry screen from what we have persisted.
    const route: Route = accessToken && account ? 'chat' : relayUrl ? 'login' : 'connect';
    set({ hydrated: true, relayUrl: url, accessToken, refreshToken, account, route });
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
    const { relayUrl, accessToken } = get();
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
