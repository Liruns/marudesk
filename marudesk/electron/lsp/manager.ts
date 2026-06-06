import fs from 'node:fs';
import path from 'node:path';
import { LspClient } from './client';
import { getActiveLspServers, type LspServerSpec } from '../diagnostics/config';
import { setLiveDiagnostics } from '../diagnostics/runner';
import type { EditorMirror } from '../../shared/context';
import type { Diagnostic } from '../../shared/diagnostics';

/**
 * Language-server manager (Tier 2, docs/workspace-language-support-design.md).
 * Mirrors the external-MCP manager's posture: lazily spawn one server per
 * (workspace root × configured server), keep it alive, fail gracefully, and tear
 * everything down on quit. Document sync is driven by the renderer's editor
 * mirror (context:sync) — main already receives open buffers there, so opening a
 * file feeds didOpen and edits feed didChange without a new renderer path.
 *
 * Diagnostics from every server for a root are merged and pushed into the
 * diagnostics runner's "live" channel, so they flow to the SAME surfaces as the
 * checker findings: read_diagnostics, the Problems popover, and Monaco squiggles.
 *
 * Opt-in: there are no built-in servers, so this is inert until the user adds one
 * to languages.json (see diagnostics/config.ts).
 */

type Entry = {
  client: LspClient;
  spec: LspServerSpec;
  root: string;
  status: 'starting' | 'ready' | 'error';
  /** Last text synced per open file, to choose didOpen vs didChange vs didClose. */
  docs: Map<string, string>;
};

/** Live client per `${root}::${serverId}`. */
const clients = new Map<string, Entry>();
/** Diagnostics per root, keyed `${serverId}::${file}` so servers don't clobber. */
const live = new Map<string, Map<string, Diagnostic[]>>();

function key(root: string, serverId: string): string {
  return `${root}::${serverId}`;
}

function extOf(file: string): string {
  const i = file.lastIndexOf('.');
  return i >= 0 ? file.slice(i).toLowerCase() : '';
}

function pushLive(root: string): void {
  const perFile = live.get(root);
  const flat: Diagnostic[] = [];
  if (perFile) for (const list of perFile.values()) flat.push(...list);
  setLiveDiagnostics(root, flat);
}

function setFileDiagnostics(root: string, serverId: string, file: string, diags: Diagnostic[]): void {
  let perFile = live.get(root);
  if (!perFile) {
    perFile = new Map();
    live.set(root, perFile);
  }
  const k = `${serverId}::${file}`;
  if (diags.length === 0) perFile.delete(k);
  else perFile.set(k, diags);
  pushLive(root);
}

function clearRoot(root: string): void {
  if (live.delete(root)) setLiveDiagnostics(root, []);
}

/** Servers whose marker file exists at the root. */
function applicableServers(root: string): LspServerSpec[] {
  return getActiveLspServers().filter((s) =>
    s.appliesWhen.some((marker) => {
      try {
        return fs.existsSync(path.join(root, marker));
      } catch {
        return false;
      }
    }),
  );
}

function startClient(root: string, spec: LspServerSpec): void {
  const k = key(root, spec.id);
  const entry: Entry = {
    client: new LspClient({
      command: spec.command,
      root,
      languageId: spec.languageId,
      source: spec.id,
      onDiagnostics: (file, diags) => setFileDiagnostics(root, spec.id, file, diags),
      onClose: () => {
        // Drop a crashed/exited server; its findings go with it.
        if (clients.get(k) === entry) clients.delete(k);
      },
    }),
    spec,
    root,
    status: 'starting',
    docs: new Map(),
  };
  clients.set(k, entry);
  entry.client
    .start()
    .then(() => {
      if (clients.get(k) === entry) entry.status = 'ready';
    })
    .catch(() => {
      // Failed to initialize (binary missing, handshake error) — drop, stay quiet.
      if (clients.get(k) === entry) clients.delete(k);
      entry.client.dispose();
    });
}

/**
 * Reconcile language servers + open documents against the latest editor mirror.
 * Called whenever context:sync updates (and on workspace change). `root` is the
 * active workspace root, or null when none is open.
 */
export function syncFromContext(root: string | null, editors: readonly EditorMirror[]): void {
  // Tear down clients for any other root (workspace switch) or no workspace.
  for (const [k, entry] of clients) {
    if (root === null || entry.root !== root) {
      entry.client.dispose();
      clients.delete(k);
      clearRoot(entry.root);
    }
  }
  if (!root) return;

  const servers = applicableServers(root);
  const serverIds = new Set(servers.map((s) => s.id));

  // Drop clients whose server is no longer configured/applicable.
  for (const [k, entry] of clients) {
    if (entry.root === root && !serverIds.has(entry.spec.id)) {
      entry.client.dispose();
      clients.delete(k);
    }
  }

  // Lazily start any newly-applicable server.
  for (const spec of servers) {
    if (!clients.has(key(root, spec.id))) startClient(root, spec);
  }

  // Sync documents for every ready client.
  for (const spec of servers) {
    const entry = clients.get(key(root, spec.id));
    if (!entry || entry.status !== 'ready') continue;

    const desired = new Map<string, string>();
    for (const ed of editors) {
      if (!ed.path || ed.path.startsWith('untitled-')) continue;
      if (!spec.extensions.includes(extOf(ed.path))) continue;
      desired.set(ed.path, ed.content);
    }

    for (const [file, text] of desired) {
      const known = entry.docs.get(file);
      if (known === undefined) entry.client.didOpen(file, text);
      else if (known !== text) entry.client.didChange(file, text);
      entry.docs.set(file, text);
    }
    for (const file of [...entry.docs.keys()]) {
      if (!desired.has(file)) {
        entry.client.didClose(file);
        entry.docs.delete(file);
        setFileDiagnostics(root, spec.id, file, []); // clear a closed file's squiggles
      }
    }
  }
}

/** Tear down every language server (call on app quit). */
export function disposeAllLsp(): void {
  for (const entry of clients.values()) entry.client.dispose();
  clients.clear();
  live.clear();
}
