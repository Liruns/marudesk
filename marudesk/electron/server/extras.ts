import type {
  BridgeModelsResult,
  BridgeProviderModels,
  BridgeSessionDetail,
  BridgeWorkspacesResult,
} from '../../shared/remote';
import type { SessionRecord } from '../../shared/context';
import { customProviderId, getProvider } from '../../shared/providers';
import { listSavedSessions, resumeSession } from '../agent/loop';
import { readSession as readSessionRecord } from '../agent/sessions-store';
import { containerForWorkspace } from '../agent/loop-state.ts';
import { listCustomProviders } from '../custom-providers';
import { getModelsFor } from '../models';
import { hasProviderKey, listProviders } from '../secrets';
import { getWorkspaceSnapshot } from '../workspace-registry';
import type { RouterExtras } from './router';

/**
 * Production backends for the router's read-mostly catalog routes (chat CLI v2
 * — docs/chat-cli-tui-design.md §4). Pure glue over existing modules so both
 * bridge servers (the loopback companion and the guarded remote server) serve
 * the same picker data the desktop UI sees.
 */

async function builtinCatalog(): Promise<BridgeProviderModels[]> {
  const statuses = await listProviders();
  return Promise.all(
    statuses.map(async (s) => {
      const def = getProvider(s.id);
      const connected = !!s.hasKey || !!s.oauth;
      // Live-fetch (5-min cached) only for connected providers; the rest get the
      // static seed so one disconnected provider can't slow the whole route.
      const models = connected
        ? await getModelsFor(s.id).catch(() => def.models)
        : def.models;
      return {
        id: s.id,
        label: def.label,
        connected,
        ...(def.experimental ? { experimental: true } : {}),
        defaultModelId: def.defaultModelId,
        models: models.map((m) => ({ id: m.id, label: m.label })),
      };
    }),
  );
}

async function customCatalog(): Promise<BridgeProviderModels[]> {
  const customs = await listCustomProviders().catch(() => []);
  return Promise.all(
    customs.map(async (c) => {
      const id = customProviderId(c.id);
      return {
        id,
        label: c.label,
        connected: await hasProviderKey(id),
        defaultModelId: c.models[0]?.id,
        // Custom endpoints have no live /models probe here — their stored
        // catalog IS the model list (same as the desktop picker).
        models: c.models.map((m) => ({ id: m.id, label: m.label })),
      };
    }),
  );
}

function flattenSession(rec: SessionRecord): string {
  return rec.messages
    .map((m) => {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => (p.type === 'text' ? p.text : '')).join('');
      const tools = m.parts
        .filter((p) => p.type === 'tool')
        .map((p) => (p.type === 'tool' ? `  · ${p.call.summary ?? p.call.name}` : ''))
        .filter(Boolean)
        .join('\n');
      const head = m.role === 'user' ? 'User' : 'Assistant';
      return `${head}: ${text.trim()}${tools ? `\n${tools}` : ''}`.trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Build the injected catalog/session backends for {@link RouterExtras}. */
export function createRouterExtras(): RouterExtras {
  return {
    async models(): Promise<BridgeModelsResult> {
      const [builtin, custom] = await Promise.all([builtinCatalog(), customCatalog()]);
      return { providers: [...builtin, ...custom] };
    },
    // No filter (undefined) keeps the CLI's cross-workspace list; a thin client
    // that selected a workspace passes its id (or null for global-only).
    sessions: (workspaceId) => listSavedSessions(workspaceId),
    // Resume into the scoped workspace's ACTIVE thread — the same container the
    // desktop UI drives — so phone and desktop continue ONE conversation. The
    // loop still refuses a cross-workspace record (sameWorkspace check).
    resumeSession: (id, workspaceId) => resumeSession(id, containerForWorkspace(workspaceId)),
    async workspaces(): Promise<BridgeWorkspacesResult> {
      const snapshot = getWorkspaceSnapshot();
      return {
        workspaces: snapshot.workspaces.map((w) => ({ id: w.id, name: w.name })),
        activeWorkspaceId: snapshot.activeWorkspaceId,
      };
    },
    async readSession(id: string): Promise<BridgeSessionDetail | null> {
      const rec = await readSessionRecord(id);
      if (!rec) return null;
      return {
        title: rec.title,
        provider: rec.provider,
        model: rec.model,
        messageCount: rec.messageCount,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        transcript: flattenSession(rec),
      };
    },
  };
}
