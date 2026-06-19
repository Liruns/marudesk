import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { Connection } from './client';

/**
 * Connection + preference resolution for the chat CLI (chat CLI v2 —
 * docs/chat-cli-tui-design.md §5). Connection precedence: explicit flags →
 * env (the embedded terminal profile injects these) → the companion's
 * same-user handshake file `cli-bridge.json` (electron/cli-bridge/companion-core.ts).
 */

export type CliArgs = {
  url: string | null;
  token: string | null;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  /** Force the plain line-mode REPL even on a TTY. */
  line: boolean;
  help: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    url: null,
    token: null,
    provider: null,
    model: null,
    prompt: null,
    line: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--line') args.line = true;
    else if (a === '--url') args.url = argv[++i] ?? null;
    else if (a === '--token') args.token = argv[++i] ?? null;
    else if (a === '--provider') args.provider = argv[++i] ?? null;
    else if (a === '--model') args.model = argv[++i] ?? null;
    else if (a === '--prompt' || a === '-p') args.prompt = argv[++i] ?? null;
  }
  return args;
}

export function userDataDir(): string {
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'),
      'marudesk',
    );
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'marudesk');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'marudesk');
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function resolveConnection(args: CliArgs): Connection | null {
  if (args.url && args.token) {
    return { url: args.url.replace(/\/+$/, ''), token: args.token };
  }
  const envUrl = process.env.MARUDESK_BRIDGE_URL;
  const envToken = process.env.MARUDESK_BRIDGE_TOKEN;
  if (envUrl && envToken) {
    return { url: envUrl.replace(/\/+$/, ''), token: envToken };
  }
  const bridge = readJsonFile(path.join(userDataDir(), 'cli-bridge.json'));
  if (bridge && typeof bridge === 'object') {
    const b = bridge as { port?: unknown; token?: unknown };
    if (typeof b.port === 'number' && typeof b.token === 'string') {
      return { url: `http://127.0.0.1:${b.port}`, token: b.token };
    }
  }
  return null;
}

/* ── remembered provider/model (cli-prefs.json, next to the handshake) ────── */

export type ModelPref = { provider: string | null; model: string | null };

const prefsFile = (): string => path.join(userDataDir(), 'cli-prefs.json');

export function loadModelPref(): ModelPref {
  const prefs = readJsonFile(prefsFile());
  const p = (prefs && typeof prefs === 'object' ? prefs : {}) as Record<string, unknown>;
  return {
    provider: typeof p.provider === 'string' ? p.provider : null,
    model: typeof p.model === 'string' ? p.model : null,
  };
}

export function saveModelPref(pref: ModelPref): void {
  try {
    mkdirSync(userDataDir(), { recursive: true });
    writeFileSync(prefsFile(), JSON.stringify(pref));
  } catch {
    // Prefs are a convenience; ignore write failures.
  }
}

/** CLI flags override (and update) the remembered provider/model. */
export function resolveModelPref(args: CliArgs): ModelPref {
  const stored = loadModelPref();
  const pref: ModelPref = {
    provider: args.provider ?? stored.provider,
    model: args.model ?? stored.model,
  };
  if (args.provider || args.model) saveModelPref(pref);
  return pref;
}
