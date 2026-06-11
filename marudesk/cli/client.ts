import type {
  AgentAnswers,
  AgentChatState,
  AgentSendInput,
  AgentSendResult,
} from '../shared/agent';
import type { SessionSummary } from '../shared/context';
import type { AgentApprovalMode } from '../shared/settings';
import type { BridgeModelsResult, RemoteHealth } from '../shared/remote';

/**
 * Typed REST + SSE client over the bridge's bearer path (chat CLI v2 —
 * docs/chat-cli-tui-design.md §5). Talks to either listener — the always-on
 * loopback companion (electron/server/companion-core.ts) or the remote bridge
 * server — through the same routes (electron/server/router.ts). Zero deps;
 * Node 20+ global fetch.
 */

export type Connection = { url: string; token: string };

export type BridgeClient = ReturnType<typeof createClient>;

export function createClient(conn: Connection) {
  const headers = {
    authorization: `Bearer ${conn.token}`,
    'content-type': 'application/json',
  } as const;

  const request = async <T>(route: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${conn.url}${route}`, { headers, ...init });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message =
        json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string'
          ? (json as { error: string }).error
          : `HTTP ${res.status}`;
      throw new Error(message);
    }
    return json as T;
  };

  const post = <T>(route: string, body: unknown): Promise<T> =>
    request<T>(route, { method: 'POST', body: JSON.stringify(body) });

  return {
    url: conn.url,
    health: () => request<RemoteHealth>('/health'),
    snapshot: () => request<AgentChatState>('/agent/snapshot'),
    models: () => request<BridgeModelsResult>('/agent/models'),
    sessions: () => request<SessionSummary[]>('/agent/sessions'),
    resumeSession: (id: string) => post<{ ok: boolean }>('/agent/resume-session', { id }),
    send: (input: AgentSendInput) => post<AgentSendResult>('/agent/send', input),
    abort: (turnId: string) => post<{ ok: boolean }>('/agent/abort', { turnId }),
    respond: (turnId: string, callId: string, answers: AgentAnswers) =>
      post<{ ok: boolean }>('/agent/respond', { turnId, callId, answers }),
    approve: (turnId: string, callId: string, approved: boolean) =>
      post<{ ok: boolean }>('/agent/approve', { turnId, callId, approved }),
    reset: () => post<{ ok: boolean }>('/agent/reset', {}),
    setApprovalMode: (mode: AgentApprovalMode) =>
      post<{ ok: boolean }>('/agent/set-approval-mode', { mode }),

    /**
     * Stream `agent:event` snapshots over SSE. Resolves when the stream ends;
     * abort via the returned controller for a clean shutdown.
     */
    events(onState: (state: AgentChatState) => void): {
      done: Promise<void>;
      stop(): void;
    } {
      const controller = new AbortController();
      const done = (async () => {
        const res = await fetch(`${conn.url}/agent/events`, {
          headers,
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`events stream failed (HTTP ${res.status})`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done: ended, value } = await reader.read();
          if (ended) break;
          buf += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              try {
                const event: unknown = JSON.parse(line.slice(6));
                const e = event as { type?: unknown; state?: unknown };
                if (e.type === 'snapshot' && e.state && typeof e.state === 'object') {
                  onState(e.state as AgentChatState);
                }
              } catch {
                // Skip a malformed frame; the next snapshot carries full state.
              }
            }
          }
        }
      })();
      return {
        done,
        stop: () => controller.abort(),
      };
    },
  };
}
