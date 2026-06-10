/**
 * marudesk chat CLI — drive the desktop app's AI Chat from a terminal.
 *
 * The desktop app must be running with the local bridge server enabled
 * (Settings → Remote → Local server). The server drops a same-user handshake
 * file (`cli-bridge.json` in userData) while it listens; this client reads it,
 * authenticates over the loopback bearer path, streams `agent:event` snapshots
 * via SSE, and sends commands over the same REST surface the mobile client uses
 * (electron/server/router.ts). Zero dependencies; Node 20+.
 *
 * Usage:
 *   npm run chat                              # interactive REPL
 *   npm run chat -- --prompt "explain x"      # one-shot: send, stream, exit
 *   npm run chat -- --provider ollama --model qwen3 --prompt "hi"
 *   npm run chat -- --url http://127.0.0.1:8787 --token <token>   # explicit
 *
 * provider/model: --provider/--model are remembered in cli-prefs.json next to
 * the handshake file, so you only pass them once.
 *
 * Approvals: non-gated parks (e.g. edit previews) can be approved here; GATED
 * tools (run_command, eval_js, …) are pinned to the desktop UI while the bridge
 * is exposed (the L-1 guard) — the CLI tells you to approve them there.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

/* ── config resolution ────────────────────────────────────────────────────── */

function userDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'marudesk');
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'marudesk');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'marudesk');
}

function parseArgs(argv) {
  const args = { url: null, token: null, provider: null, model: null, prompt: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--url') args.url = argv[++i] ?? null;
    else if (a === '--token') args.token = argv[++i] ?? null;
    else if (a === '--provider') args.provider = argv[++i] ?? null;
    else if (a === '--model') args.model = argv[++i] ?? null;
    else if (a === '--prompt' || a === '-p') args.prompt = argv[++i] ?? null;
  }
  return args;
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function resolveConnection(args) {
  if (args.url && args.token) return { url: args.url.replace(/\/+$/, ''), token: args.token };
  const envUrl = process.env.MARUDESK_BRIDGE_URL;
  const envToken = process.env.MARUDESK_BRIDGE_TOKEN;
  if (envUrl && envToken) return { url: envUrl.replace(/\/+$/, ''), token: envToken };
  const bridge = readJsonFile(path.join(userDataDir(), 'cli-bridge.json'));
  if (bridge && typeof bridge.port === 'number' && typeof bridge.token === 'string') {
    return { url: `http://127.0.0.1:${bridge.port}`, token: bridge.token };
  }
  return null;
}

const prefsFile = () => path.join(userDataDir(), 'cli-prefs.json');

function resolveModelRef(args) {
  const prefs = readJsonFile(prefsFile()) ?? {};
  const provider = args.provider ?? prefs.provider ?? null;
  const model = args.model ?? prefs.model ?? null;
  if (args.provider || args.model) {
    try {
      mkdirSync(userDataDir(), { recursive: true });
      writeFileSync(prefsFile(), JSON.stringify({ provider, model }));
    } catch {
      // prefs are a convenience; ignore write failures
    }
  }
  return { provider, model };
}

/* ── tiny REST client ─────────────────────────────────────────────────────── */

function api(conn) {
  const headers = { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json' };
  const post = async (route, body) => {
    const res = await fetch(`${conn.url}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  };
  const get = async (route) => {
    const res = await fetch(`${conn.url}${route}`, { headers });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  };
  return { post, get, headers };
}

/* ── SSE stream → state snapshots ─────────────────────────────────────────── */

async function streamEvents(conn, headers, onState, onEnd) {
  const res = await fetch(`${conn.url}/agent/events`, { headers });
  if (!res.ok || !res.body) throw new Error(`events stream failed (HTTP ${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'snapshot') onState(event.state);
          } catch {
            // skip malformed frames; the next snapshot carries full state
          }
        }
      }
    }
  } finally {
    onEnd();
  }
}

/* ── snapshot rendering ───────────────────────────────────────────────────── */

const dim = (s) => `[2m${s}[22m`;
const bold = (s) => `[1m${s}[22m`;
const red = (s) => `[31m${s}[39m`;
const green = (s) => `[32m${s}[39m`;

function makeRenderer(io) {
  const printedText = new Map(); // assistant message id -> chars already printed
  const toolPrinted = new Map(); // call id -> last printed state
  const BUSY = new Set(['thinking', 'working', 'waiting_for_user']);
  let lastStatus = 'idle';
  let openLine = false; // a streamed text line is mid-flight (no trailing \n)

  const breakLine = () => {
    if (openLine) {
      io.write('\n');
      openLine = false;
    }
  };

  return {
    /** Render one snapshot; returns 'settled' when a busy turn just finished. */
    render(state) {
      // Streamed assistant text: print only the unprinted tail of the LAST
      // assistant message (earlier ones are already on screen).
      const last = [...state.messages].reverse().find((m) => m.role === 'assistant');
      if (last) {
        const text = last.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
        const done = printedText.get(last.id) ?? 0;
        if (text.length > done) {
          io.write(text.slice(done));
          printedText.set(last.id, text.length);
          openLine = !text.endsWith('\n');
        }
      }
      // Tool cards: one compact line per state transition worth showing.
      for (const m of state.messages) {
        for (const part of m.parts) {
          if (part.type !== 'tool') continue;
          const call = part.call;
          const prev = toolPrinted.get(call.id);
          if (prev === call.state) continue;
          toolPrinted.set(call.id, call.state);
          if (call.state === 'running') {
            breakLine();
            io.write(dim(`  ⚙ ${call.name}${call.summary ? ` — ${call.summary}` : ''}\n`));
          } else if (call.state === 'ok') {
            breakLine();
            io.write(dim(`  ✓ ${call.name}${call.summary ? ` — ${call.summary}` : ''}\n`));
          } else if (call.state === 'error' || call.state === 'denied') {
            breakLine();
            io.write(dim(red(`  ✗ ${call.name} (${call.state})\n`)));
          }
        }
      }
      const settled = BUSY.has(lastStatus) && (state.status === 'completed' || state.status === 'failed');
      lastStatus = state.status;
      if (settled) {
        breakLine();
        if (state.status === 'failed') {
          io.write(red(`✗ ${state.error ?? 'turn failed'}\n`));
        } else {
          const note = state.endNote ? ` (${state.endNote})` : '';
          const u = state.usage ?? {};
          io.write(green(`✔ done${note}`) + dim(` · in ${u.inputTokens ?? 0} / out ${u.outputTokens ?? 0} tok\n`));
        }
      }
      return settled;
    },
    breakLine,
  };
}

/* ── interaction (approvals / questions) ──────────────────────────────────── */

function makeInteractor(rl, client, renderer, io) {
  const handled = new Set();
  return async (state) => {
    const approval = state.pendingApproval;
    if (approval && !handled.has(approval.callId)) {
      handled.add(approval.callId);
      renderer.breakLine();
      io.write(`\n${bold('approval needed')}: ${approval.name}\n${dim(approval.detail ?? '')}\n`);
      const answer = (await rl.question('[a]pprove / [d]eny > ')).trim().toLowerCase();
      try {
        await client.post('/agent/approve', {
          turnId: approval.turnId,
          callId: approval.callId,
          approved: answer === 'a' || answer === 'approve' || answer === 'y',
        });
      } catch (err) {
        // The L-1 guard pins gated-tool approvals to the desktop while exposed.
        io.write(red(`${err.message}\n`));
      }
      return;
    }
    const questions = state.pendingQuestions;
    if (questions && !handled.has(questions.callId)) {
      handled.add(questions.callId);
      renderer.breakLine();
      const answers = {};
      for (const q of questions.questions) {
        io.write(`\n${bold('question')}: ${q.question}\n`);
        if (q.options?.length) io.write(dim(`options: ${q.options.join(' | ')}\n`));
        answers[q.id] = (await rl.question('> ')).trim();
      }
      try {
        await client.post('/agent/respond', { turnId: questions.turnId, callId: questions.callId, answers });
      } catch (err) {
        io.write(red(`${err.message}\n`));
      }
    }
  };
}

/* ── main ─────────────────────────────────────────────────────────────────── */

const HELP = `marudesk chat CLI
  --prompt,-p <text>   one-shot: send, stream the reply, exit
  --provider <id>      provider id (remembered in cli-prefs.json)
  --model <id>         model id (remembered)
  --url <url>          bridge URL (else env MARUDESK_BRIDGE_URL, else cli-bridge.json)
  --token <token>      bearer token (else env MARUDESK_BRIDGE_TOKEN, else cli-bridge.json)
Requires the desktop app running with Settings → Remote → Local server enabled.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const io = process.stdout;
  if (args.help) {
    io.write(`${HELP}\n`);
    return;
  }
  const conn = resolveConnection(args);
  if (!conn) {
    io.write(`${red('no bridge connection')} — start marudesk, enable Settings → Remote → Local server,\n` +
      `or pass --url/--token (env: MARUDESK_BRIDGE_URL / MARUDESK_BRIDGE_TOKEN).\n`);
    process.exitCode = 1;
    return;
  }
  const client = api(conn);
  let health;
  try {
    health = await client.get('/health');
  } catch (err) {
    io.write(red(`could not reach the bridge at ${conn.url}: ${err.message}\n`));
    process.exitCode = 1;
    return;
  }
  io.write(dim(`connected — marudesk v${health.version} at ${conn.url}\n`));

  const { provider, model } = resolveModelRef(args);
  if (!provider || !model) {
    io.write(`${red('no model selected')} — pass --provider and --model once (they are remembered),\n` +
      `e.g. npm run chat -- --provider anthropic --model claude-sonnet-4-6 --prompt "hi"\n`);
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const renderer = makeRenderer(io);
  const interact = makeInteractor(rl, client, renderer, io);

  let activeTurnId = null;
  let settle = null; // resolves when the active turn finishes
  let streamClosed = false;
  const onState = (state) => {
    const settled = renderer.render(state);
    void interact(state);
    if (settled) {
      activeTurnId = null;
      settle?.();
    }
  };
  void streamEvents(conn, client.headers, onState, () => {
    streamClosed = true;
    settle?.();
  }).catch((err) => {
    io.write(red(`event stream error: ${err.message}\n`));
    streamClosed = true;
    settle?.();
  });

  // Ctrl+C: abort the active turn first; a second ^C (or no turn) exits.
  rl.on('SIGINT', () => {
    if (activeTurnId) {
      const t = activeTurnId;
      activeTurnId = null;
      io.write(dim('\naborting…\n'));
      void client.post('/agent/abort', { turnId: t }).catch(() => {});
    } else {
      rl.close();
      process.exit(0);
    }
  });

  const send = async (prompt) => {
    const res = await client.post('/agent/send', { provider, model, prompt, captures: [] });
    if (!res.ok) {
      io.write(red(`not sent: ${res.reason ?? 'unknown reason'}\n`));
      return false;
    }
    activeTurnId = res.turnId ?? null;
    await new Promise((resolve) => {
      settle = resolve;
    });
    settle = null;
    return true;
  };

  if (args.prompt) {
    await send(args.prompt);
    rl.close();
    process.exit(streamClosed && activeTurnId !== null ? 1 : 0);
  }

  io.write(dim(`${provider}/${model} — type a prompt, Ctrl+C to abort/exit\n`));
  for (;;) {
    const line = (await rl.question(bold('marudesk> '))).trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (streamClosed) {
      io.write(red('event stream closed — restart the CLI.\n'));
      break;
    }
    await send(line);
  }
  rl.close();
}

await main();
